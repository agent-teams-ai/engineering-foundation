const identifier = (node) => node?.type === "Identifier";
const plain = (node) => !node.static && !node.computed && !node.optional && !node.override && !node.declare && !node.decorators?.length;
function scalarType(node, aliases, active = new Set()) {
  if (["TSStringKeyword", "TSNumberKeyword", "TSBooleanKeyword", "TSNullKeyword"].includes(node?.type)) {return true;}
  if (node?.type === "TSLiteralType") {return node.literal.type === "Literal" && !node.literal.regex;}
  if (node?.type === "TSUnionType") {return node.types.every((item) => scalarType(item, aliases, active));}
  if (node?.type !== "TSTypeReference" || !identifier(node.typeName) || node.typeArguments || active.has(node.typeName.name) || active.size >= 32) {return false;}
  return scalarType(aliases.get(node.typeName.name), aliases, new Set([...active, node.typeName.name]));
}
function message(node, parameter) {
  if (identifier(node)) {return node.name === parameter;}
  if (node?.type === "Literal") {return typeof node.value === "string";}
  return node?.type === "TemplateLiteral" && node.expressions.every((part) => identifier(part) && part.name === parameter);
}
function assignment(statement, property, value) {
  const expression = statement?.type === "ExpressionStatement" && statement.expression;
  const left = expression?.left;
  return expression?.type === "AssignmentExpression" && expression.operator === "=" &&
    left?.type === "MemberExpression" && !left.computed && !left.optional && left.object.type === "ThisExpression" &&
    identifier(left.property) && left.property.name === property && value(expression.right);
}
function errorHeader(node) {
  return node.type === "ClassDeclaration" && identifier(node.id) && node.superClass?.name === "Error" &&
    identifier(node.superClass) && !node.abstract && !node.declare && !node.typeParameters && !node.implements?.length && !node.decorators?.length;
}
function scalarField(field, aliases) {
  return plain(field) && field.readonly && !field.value && identifier(field.key) && field.key.name !== "name" &&
    [undefined, null, "public"].includes(field.accessibility) && scalarType(field.typeAnnotation?.typeAnnotation, aliases);
}
function constructorParameter(constructor, aliases) {
  const fn = constructor.value;
  if (!plain(constructor) || ![undefined, null, "public"].includes(constructor.accessibility) || fn.async || fn.generator || fn.params.length !== 1 || fn.typeParameters) {return;}
  const param = fn.params[0];
  return identifier(param) && !param.optional && !param.decorators?.length && scalarType(param.typeAnnotation?.typeAnnotation, aliases) ? param : undefined;
}
function errorInitialization(constructor, fields, name, param) {
  const statements = constructor.value.body?.body ?? [];
  const call = statements[0]?.type === "ExpressionStatement" && statements[0].expression;
  if (statements.length !== fields.length + 2 || call?.type !== "CallExpression" || call.callee.type !== "Super" || call.arguments.length !== 1 || !message(call.arguments[0], param.name)) {return false;}
  if (!assignment(statements[1], "name", (value) => value.type === "Literal" && value.value === name)) {return false;}
  return fields.every((field, index) => assignment(statements[index + 2], field.key.name, (value) => identifier(value) && value.name === param.name));
}
function dataError(node, aliases) {
  if (!errorHeader(node)) {return false;}
  const fields = node.body.body.filter((item) => item.type === "PropertyDefinition");
  const constructors = node.body.body.filter((item) => item.type === "MethodDefinition" && item.kind === "constructor");
  if (fields.length > 1 || constructors.length !== 1 || node.body.body.length !== fields.length + 1 || !fields.every((field) => scalarField(field, aliases))) {return false;}
  const param = constructorParameter(constructors[0], aliases);
  return Boolean(param && errorInitialization(constructors[0], fields, node.id.name, param));
}

/** Only scalar error records; no general class, inheritance or instance behavior admission. */
export function primitiveErrorClasses(program) {
  const declarations = program.body.map((statement) => statement.declaration ?? statement);
  const aliases = new Map(declarations.filter((node) => node.type === "TSTypeAliasDeclaration" && !node.typeParameters)
    .map((node) => [node.id.name, node.typeAnnotation]));
  return new Set(declarations.filter((node) => dataError(node, aliases)));
}
