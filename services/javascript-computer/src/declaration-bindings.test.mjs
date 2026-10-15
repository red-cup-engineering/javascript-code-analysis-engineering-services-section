import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {parseJavaScript,bindJavaScript} from '@red-cup-engineering/javascript-node-services-section/javascript-parser';
import {locateDocSymbols,readSymbolSource,setJsDoc} from './documentation-edit.mjs';
import {introspectDeclarationsByFile} from './introspect.mjs';
import {indexModuleCorpus} from './module-corpus.mjs';
const cases=[
 ['renamed keys, nested arrays, holes and rest', 'export const {key: local, nested: {leaf: renamed}, array: [first,, third], ...rest} = source;', ['local','renamed','first','third','rest']],
 ['shorthand defaults and nested patterns', 'export let {a = 1, b: {c = 2} = {}, d: [e = 3, ...tail] = []} = source;', ['a','c','e','tail']],
 ['computed key references are not declarations', 'const key = "name"; export const {[key]: value, [(() => { const innerKey = "other"; return innerKey; })()]: other} = source;', ['value','other']],
 ['nested initializer lexical declarations stay private', 'export const {a = function hidden(parameter) { var local; return parameter; }, b = class Hidden { static { var staticLocal; } method(methodParameter) { let methodLocal; } }, c = ((arrowParameter) => { const arrowLocal = arrowParameter; return arrowLocal; })(1)} = source;', ['a','b','c']],
 ['separate declarators retain source order', 'export const {a: one} = source, [two, ...three] = source, four = () => 4;', ['one','two','three','four']],
 ['unexported earlier var shares exported binding', 'var a; export var {key: a, fresh} = source;', ['a','fresh']],
 ['unexported earlier simple var remains exportable', 'var a; export var a = 1;', ['a']],
 ['multiple existing vars across exported declarators', 'var a, b; export var {key: a} = source, [b, c] = source;', ['a','b','c']],
 ['later var occurrence preserves preceding export', 'export var a = 1; var a = 2;', ['a']],
];
for (const [name,source,expected] of cases) {
 test(`documented export names: ${name}`,()=>{
  const native=spawnSync(process.execPath,['--check','--input-type=module'],{input:source,encoding:'utf8'});assert.equal(native.status,0,native.stderr);
  parseJavaScript(source);
  assert.deepEqual(locateDocSymbols('fixture.mjs',source).map(x=>x.name),expected);
  for(const exported of expected) assert.ok(readSymbolSource('fixture.mjs',exported,{},source)?.startsWith('export '));
 });
 test(`introspection exports and exact coordinates: ${name}`,()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'code-bindings-'));try{
   const file=path.join(dir,'fixture.mjs');writeFileSync(file,source);
   const result=introspectDeclarationsByFile([file])[0];
   assert.deepEqual(result.exports,expected.map(name=>({name,local:name})));
   for(const location of result.locations) {
    assert.equal(location.line,1); assert.ok(source.slice(location.column-1).startsWith(location.name));
   }
   assert.deepEqual(result.catalog.functions.map(x=>x.name),expected.includes('four')?['four']:[]);
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
 test(`cross-module imported declarations: ${name}`,()=>{
  const imports=`import {${expected.join(',')}} from './source.mjs';`;
  const corpus=indexModuleCorpus({files:[{absolutePath:'/source.mjs',content:source},{absolutePath:'/barrel.mjs',content:"export * from './source.mjs';"},{absolutePath:'/consumer.mjs',content:imports.replace('./source.mjs','./barrel.mjs')}],resolve:(specifier,from)=>path.resolve(path.dirname(from),specifier)});
  const decl=corpus.modules.get('/consumer.mjs').program.body[0];
  for(const specifier of decl.specifiers) {
   const found=corpus.declarationsOf(specifier.local);
   assert.equal(found.length,1,`${specifier.local.name} resolved exactly once`);
   assert.equal(corpus.declarationName(found[0]),specifier.local.name);
   assert.equal(corpus.moduleOf(found[0]).fileName,'/source.mjs');
  }
 });
}
test('documentation edits apply to shared export statement, preserving source bytes',()=>{
 const source='/** Original. */\nexport const {a: first, nested: [second = () => 2]} = source;\n';
 const updated=setJsDoc(source,'second','Replacement.');
 assert.equal(updated,source.replace('/** Original. */','/** Replacement. */'));
 const symbols=locateDocSymbols('fixture.mjs',updated);
 assert.deepEqual(symbols.map(x=>[x.name,x.doc]),[['first','Replacement.'],['second','Replacement.']]);
});
test('local destructuring aliases and named reexports preserve local identity',()=>{
 const source='const {outer: {inner: local = (() => { const secret = 1; return secret; })()}} = source; export {local as publicName};';
 const corpus=indexModuleCorpus({files:[{absolutePath:'/source.mjs',content:source},{absolutePath:'/barrel.mjs',content:"export { publicName as exposed } from './source.mjs';"},{absolutePath:'/consumer.mjs',content:"import {exposed} from './barrel.mjs'; exposed;"}],resolve:(s,f)=>path.resolve(path.dirname(f),s)});
 const usage=corpus.modules.get('/consumer.mjs').program.body[1].expression;
 const found=corpus.declarationsOf(usage);assert.equal(found.length,1);assert.equal(corpus.declarationName(found[0]),'local');
});

test('binder occurrence relation preserves canonical identity for repeated var declarations',()=>{
 const source='var a, b; var a = 1; export var {key: a, nested: [b], fresh = (() => { const hidden = 1; return hidden; })()} = source;';
 const program=parseJavaScript(source);const bound=bindJavaScript(program);
 const a=bound.bindings.find(x=>x.name==='a'&&x.scope.node===program);
 const occurrences=bound.declarationOccurrences.filter(x=>x.binding===a);
 assert.equal(occurrences.length,3);
 assert.equal(new Set(occurrences.map(x=>x.identifier)).size,3);
 for(const occurrence of bound.declarationOccurrences) assert.strictEqual(bound.references.get(occurrence.identifier),occurrence.binding);
 assert.deepEqual(bound.declarationOccurrences.filter(x=>x.binding.scope.node===program).map(x=>x.identifier.name),['a','b','a','a','b','fresh']);
});
test('separate modules may import and reexport the same lexical name',()=>{
 const corpus=indexModuleCorpus({files:[{absolutePath:'/provider.mjs',content:'var value; export var value = 1;'}, {absolutePath:'/bridge.mjs',content:"import {value} from './provider.mjs'; export {value};"},{absolutePath:'/consumer.mjs',content:"import {value} from './bridge.mjs'; value;"}],resolve:(s,f)=>path.resolve(path.dirname(f),s)});
 const usage=corpus.modules.get('/consumer.mjs').program.body[1].expression;
 const found=corpus.declarationsOf(usage);assert.equal(found.length,1);assert.equal(corpus.moduleOf(found[0]).fileName,'/provider.mjs');assert.equal(corpus.declarationName(found[0]),'value');
});
