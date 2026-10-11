import assert from "node:assert/strict";
import test from "node:test";
import { extractExecutableBehaviors } from "./executable-behaviors.mjs";

test("semantic fingerprints ignore local names and literal policy values", () => {
  const left = extractExecutableBehaviors("function read(file) { return readFileSync(file, 'utf8') || 'first fallback'; }", "left.mjs")[0];
  const right = extractExecutableBehaviors("function load(path) { return readFileSync(path, 'utf8') || 'second fallback'; }", "right.mjs")[0];
  assert.equal(left.semanticFingerprint, right.semanticFingerprint);
  assert.notEqual(left.implementationFingerprint, right.implementationFingerprint);
});

test("semantic fingerprints distinguish encoding direction and retain ordinary policy variants", () => {
  const encode = extractExecutableBehaviors("function encode(raw) { return Buffer.from(raw, 'utf8').toString('hex'); }", "encode.mjs")[0];
  const decode = extractExecutableBehaviors("function decode(atom) { return Buffer.from(atom, 'hex').toString('utf8'); }", "decode.mjs")[0];
  const renamed = extractExecutableBehaviors("function same(value) { return Buffer.from(value, 'utf8').toString('hex'); }", "same.mjs")[0];
  assert.notEqual(encode.semanticFingerprint, decode.semanticFingerprint);
  assert.equal(encode.semanticFingerprint, renamed.semanticFingerprint);
  const modeA = extractExecutableBehaviors("function work(x) { return render(x, 'compact'); }", "a.mjs")[0];
  const modeB = extractExecutableBehaviors("function work(y) { return render(y, 'expanded'); }", "b.mjs")[0];
  assert.equal(modeA.semanticFingerprint, modeB.semanticFingerprint);
});

test("semantic fingerprints retain object schema keys while ignoring local names and values", () => {
  const left = extractExecutableBehaviors("function make(status) { return { status: status, retries: 1 }; }", "left.mjs")[0];
  const right = extractExecutableBehaviors("function make(input) { return { status: input, retries: 2 }; }", "right.mjs")[0];
  const differentSchema = extractExecutableBehaviors("function make(input) { return { objectSignature: input, retries: 2 }; }", "different.mjs")[0];
  assert.equal(left.semanticFingerprint, right.semanticFingerprint);
  assert.notEqual(left.semanticFingerprint, differentSchema.semanticFingerprint);
});

test("semantic fingerprints retain computed string and method schema keys", () => {
  const status = extractExecutableBehaviors("function make(input) { return { ['status']: input, carrier() { return input; } }; }", "status.mjs")[0];
  const signature = extractExecutableBehaviors("function make(input) { return { ['objectSignature']: input, markovKernel() { return input; } }; }", "signature.mjs")[0];
  assert.notEqual(status.semanticFingerprint, signature.semanticFingerprint);
});

test("semantic fingerprints retain invoked APIs and control flow", () => {
  const read = extractExecutableBehaviors("function work(x) { return readFileSync(x); }", "read.mjs")[0];
  const write = extractExecutableBehaviors("function work(x) { return writeFileSync(x); }", "write.mjs")[0];
  const branched = extractExecutableBehaviors("function work(x) { if (x) return readFileSync(x); }", "branch.mjs")[0];
  assert.notEqual(read.semanticFingerprint, write.semanticFingerprint);
  assert.notEqual(read.semanticFingerprint, branched.semanticFingerprint);
});

test("semantic fingerprints traverse every statement instead of stopping after the first child", () => {
  const read = extractExecutableBehaviors("function work(x) { prepare(x); return readFileSync(x); }", "read.mjs")[0];
  const write = extractExecutableBehaviors("function work(x) { prepare(x); return writeFileSync(x); }", "write.mjs")[0];
  assert.notEqual(read.semanticFingerprint, write.semanticFingerprint);
});

test("semantic fingerprints distinguish thin wrappers that delegate to different outer bindings", () => {
  // Reproduces a real false-positive duplication candidate: two admission
  // functions with the identical AST shape `return X.assert(input);`
  // but a different contract object X and result type T are NOT the same
  // operation, even though only their local parameter name and free
  // identifiers differ syntactically.
  const message = extractExecutableBehaviors(
    "function openaiChatMessage(input) { return openaiChatMessageContract.assert(input); }",
    "message.mjs",
  )[0];
  const toolCall = extractExecutableBehaviors(
    "function openaiChatToolCall(input) { return openaiChatToolCallContract.assert(input); }",
    "toolCall.mts",
  )[0];
  assert.notEqual(message.semanticFingerprint, toolCall.semanticFingerprint);
});

test("semantic fingerprints still match true duplicates that share a free identifier under different local parameter names", () => {
  const left = extractExecutableBehaviors(
    "function openaiChatMessage(input) { return openaiChatMessageContract.assert(input); }",
    "left.mjs",
  )[0];
  const right = extractExecutableBehaviors(
    "function readMessage(payload) { return openaiChatMessageContract.assert(payload); }",
    "right.mjs",
  )[0];
  assert.equal(left.semanticFingerprint, right.semanticFingerprint);
  assert.notEqual(left.implementationFingerprint, right.implementationFingerprint);
});
