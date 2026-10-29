/** Source syntax, declarations, imports, documentation, and executable behavior. */
export {
  introspectDeclarations,
  introspectDeclarationsByFile,
  introspectDirectory,
} from "./introspect.mjs";
export type { FileCatalog, DeclarationLocation, Reexport } from "./introspect.mjs";
export { readImports, introspectImports } from "./imports.mjs";
export type { ImportBinding, FileImports } from "./imports.mjs";
export { extractDocSurface } from "./documentation.mjs";
export type { DocSymbol, DocSymbolKind } from "./documentation.mjs";
export {
  locateDocSymbols,
  readSymbolSource,
  setJsDoc,
  formatJsDoc,
} from "./documentation-edit.mjs";
export type { DeclaredSymbol } from "./documentation-edit.mjs";
export { discoverJavaScriptSourceFiles, discoverJavaScriptPackageSources } from "./source-files.mjs";
export type { JavaScriptSourceFileOptions, JavaScriptPackageSources } from "./source-files.mjs";
export { extractExecutableBehaviors } from "./executable-behaviors.mjs";
export type { ExecutableBehavior, ExecutableBehaviorKind } from "./executable-behaviors.mjs";
export { callableSubstitutionForm } from "./callable-substitution.mjs";

export { eachWorkspacePackageDir } from "./packages.mjs";
export type { DiscoveredPackage, WorkspaceFilter } from "./packages.mjs";
export { workspaceTypeIndex } from "./workspace.mjs";
export type { WorkspaceTypeIndex, SourceLocation, PublicImport, AttributedType, AttributedFunction, AttributedSubtype } from "./workspace.mjs";
