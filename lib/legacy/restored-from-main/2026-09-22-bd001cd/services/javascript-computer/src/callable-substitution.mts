import ts from "typescript";

/** A conservative comparison form for a module-level callable. Unlike the
 * discovery fingerprint, this retains constants, parameter defaults, binding
 * relationships and captured module identity. Null means unsupported syntax.
 * It assumes the same standard JavaScript globals in the receiving runtime;
 * it is not a proof about effects, reflection or arbitrary program equivalence. */
export function callableSubstitutionForm(text: string, file: string, name: string): string | null {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const host = ts.createCompilerHost({ noLib: true, noResolve: true, allowJs: true });
  host.getSourceFile = (requested) => requested === file ? source : undefined;
  host.fileExists = (requested) => requested === file;
  host.readFile = (requested) => requested === file ? text : undefined;
  const checker = ts.createProgram([file], { noLib: true, noResolve: true, allowJs: true }, host).getTypeChecker();
  let callable: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined;
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) callable = statement;
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer
        && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) callable = declaration.initializer;
    }
  }
  if (!callable?.body) return null;
  const root = callable;
  const locals = new Map<ts.Symbol, number>();
  // Bind symbols before serializing references, including forward references.
  function collect(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol?.declarations?.some((d) => d.pos >= root.pos && d.end <= root.end)
        && !locals.has(symbol)) locals.set(symbol, locals.size);
    }
    node.forEachChild(collect);
  }
  collect(root);
  let unsupported = false;
  const globals = new Set(["undefined", "NaN", "Infinity", "Object", "Array", "Number", "String", "Boolean", "BigInt", "Math", "JSON", "Date", "RegExp", "Map", "Set", "WeakMap", "WeakSet", "Promise", "Symbol", "Error", "TypeError", "RangeError", "Buffer", "Uint8Array"]);
  function form(node: ts.Node): unknown {
    // These can observe the binding environment or callable identity in ways
    // that renaming/re-homing cannot preserve with this comparison.
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword
      || ts.isMetaProperty(node) || (ts.isIdentifier(node) && ["eval", "arguments"].includes(node.text))) unsupported = true;
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      if ((ts.isPropertyAccessExpression(parent) && parent.name === node)
        || ((ts.isPropertyAssignment(parent) || ts.isBindingElement(parent)) && (ts.isBindingElement(parent) ? parent.propertyName : parent.name) === node)) return ["property", node.text];
      if (ts.isShorthandPropertyAssignment(parent)) return ["shorthand", node.text];
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol && locals.has(symbol)) return ["local", locals.get(symbol)];
      if (!symbol?.declarations?.length && globals.has(node.text)) return ["global", node.text];
      return ["capture", file, node.text];
    }
    if (ts.isLiteralExpression(node) || ts.isTemplateLiteralToken(node)) return [node.kind, node.text];
    const children: unknown[] = [];
    node.forEachChild((child) => {
      if (node === root && (child === root.name || child.kind === ts.SyntaxKind.ExportKeyword || child.kind === ts.SyntaxKind.DefaultKeyword)) return;
      children.push(form(child));
    });
    return [node.kind, ...children];
  }
  const result = JSON.stringify(form(root));
  return unsupported ? null : result;
}
