// The declarations footprints track, as tree-sitter queries. Kept as strings, not .scm files, so neither wrangler
// nor the tests need a rule for them.
//
// @decl.<kind> captures the declaration, @name its name, @class the class that owns a member. Only top-level
// declarations and members of top-level classes match: a pattern's parent is always the program or an export
// statement, so nested functions, namespaces and `declare module` blocks are never counted.

const CLASS_MEMBERS_TS = `body: (class_body [
  (method_definition name: (_) @name) @decl.method
  (method_signature name: (_) @name) @decl.method
  (abstract_method_signature name: (_) @name) @decl.method
  (public_field_definition name: (_) @name) @decl.field])`;

/** TypeScript and TSX (the same node types). */
export const TYPESCRIPT_QUERY = `
; top level, not exported
(program (function_declaration name: (identifier) @name) @decl.function)
(program (generator_function_declaration name: (identifier) @name) @decl.function)
(program (function_signature name: (identifier) @name) @decl.function)
(program (class_declaration name: (type_identifier) @name) @decl.class)
(program (abstract_class_declaration name: (type_identifier) @name) @decl.class)
(program (interface_declaration name: (type_identifier) @name) @decl.interface)
(program (type_alias_declaration name: (type_identifier) @name) @decl.type)
(program (enum_declaration name: (identifier) @name) @decl.enum)
(program (lexical_declaration (variable_declarator name: (identifier) @name) @decl.variable))
(program (variable_declaration (variable_declarator name: (identifier) @name) @decl.variable))

; exported: export, export default
(program (export_statement declaration: (function_declaration name: (identifier) @name) @decl.function))
(program (export_statement declaration: (generator_function_declaration name: (identifier) @name) @decl.function))
(program (export_statement declaration: (function_signature name: (identifier) @name) @decl.function))
(program (export_statement declaration: (class_declaration name: (type_identifier) @name) @decl.class))
(program (export_statement declaration: (abstract_class_declaration name: (type_identifier) @name) @decl.class))
(program (export_statement declaration: (interface_declaration name: (type_identifier) @name) @decl.interface))
(program (export_statement declaration: (type_alias_declaration name: (type_identifier) @name) @decl.type))
(program (export_statement declaration: (enum_declaration name: (identifier) @name) @decl.enum))
(program (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name) @decl.variable)))
(program (export_statement declaration: (variable_declaration (variable_declarator name: (identifier) @name) @decl.variable)))

; export default without a name: the declaration is called "default"
(program (export_statement value: (function_expression) @decl.function))
(program (export_statement value: (class) @decl.class))

; members of top-level classes, as Class.member
(program (class_declaration name: (type_identifier) @class ${CLASS_MEMBERS_TS}))
(program (abstract_class_declaration name: (type_identifier) @class ${CLASS_MEMBERS_TS}))
(program (export_statement declaration: (class_declaration name: (type_identifier) @class ${CLASS_MEMBERS_TS})))
(program (export_statement declaration: (abstract_class_declaration name: (type_identifier) @class ${CLASS_MEMBERS_TS})))
`;

const CLASS_MEMBERS_JS = `body: (class_body [
  (method_definition name: (_) @name) @decl.method
  (field_definition property: (_) @name) @decl.field])`;

/** JavaScript and JSX. */
export const JAVASCRIPT_QUERY = `
; top level, not exported
(program (function_declaration name: (identifier) @name) @decl.function)
(program (generator_function_declaration name: (identifier) @name) @decl.function)
(program (class_declaration name: (identifier) @name) @decl.class)
(program (lexical_declaration (variable_declarator name: (identifier) @name) @decl.variable))
(program (variable_declaration (variable_declarator name: (identifier) @name) @decl.variable))

; exported: export, export default
(program (export_statement declaration: (function_declaration name: (identifier) @name) @decl.function))
(program (export_statement declaration: (generator_function_declaration name: (identifier) @name) @decl.function))
(program (export_statement declaration: (class_declaration name: (identifier) @name) @decl.class))
(program (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name) @decl.variable)))
(program (export_statement declaration: (variable_declaration (variable_declarator name: (identifier) @name) @decl.variable)))

; export default without a name: the declaration is called "default"
(program (export_statement value: (function_expression) @decl.function))
(program (export_statement value: (class) @decl.class))

; members of top-level classes, as Class.member
(program (class_declaration name: (identifier) @class ${CLASS_MEMBERS_JS}))
(program (export_statement declaration: (class_declaration name: (identifier) @class ${CLASS_MEMBERS_JS})))
`;
