const identifier = (node) => node?.type === "Identifier";
const member = (node) => node?.type === "MemberExpression" && !node.computed && !node.optional;
const undecorated = (node) => !node.decorators?.length;
function simpleMethod(node, kind) {
  return node.type === "MethodDefinition" && node.kind === kind && !node.static && !node.computed &&
    !node.optional && !node.override && undecorated(node) && identifier(node.key) &&
    [null, undefined, "public"].includes(node.accessibility) && !node.value.generator &&
    !node.value.typeParameters && node.value.params.every((param) => identifier(param) && undecorated(param)) &&
    node.value.body?.body.length === 1;
}
function privateReceiver(node, name) {
  return member(node) && node.object.type === "ThisExpression" && node.property.type === "PrivateIdentifier" && node.property.name === name;
}
function fieldConstructor(field, constructor, context, wiring) {
  if (!simpleMethod(constructor, "constructor") || constructor.value.async) {return false;}
  const statement = constructor.value.body.body[0];
  const assignment = statement.type === "ExpressionStatement" && statement.expression;
  if (assignment?.type !== "AssignmentExpression" || assignment.operator !== "=" || !privateReceiver(assignment.left, field.key.name)) {return false;}
  const created = assignment.right;
  const type = field.typeAnnotation?.typeAnnotation;
  if (created.type !== "NewExpression" || !identifier(created.callee) || type?.type !== "TSTypeReference" ||
      !identifier(type.typeName) || type.typeArguments || type.typeName.name !== created.callee.name) {return false;}
  const nested = { ...context, names: new Map(context.names) };
  for (const param of constructor.value.params) {nested.names.set(param.name, "input");}
  return nested.names.get(created.callee.name) === "factory" && wiring(created, nested);
}
function forwardedMethod(method, fieldName) {
  if (!simpleMethod(method, "method")) {return false;}
  const statement = method.value.body.body[0];
  if (statement.type !== "ReturnStatement") {return false;}
  const result = statement.argument?.type === "AwaitExpression" ? statement.argument.argument : statement.argument;
  if (result?.type !== "CallExpression" || result.optional || !member(result.callee) ||
      !privateReceiver(result.callee.object, fieldName) || !identifier(result.callee.property) ||
      result.callee.property.name !== method.key.name) {return false;}
  return result.arguments.length === method.value.params.length && result.arguments.every((argument, index) =>
    identifier(argument) && argument.name === method.value.params[index].name);
}

function privateDelegateField(field) {
  return field.key.type === "PrivateIdentifier" && field.readonly && !field.value && !field.static && !field.computed &&
    !field.declare && !field.override && !field.optional && !field.definite && undecorated(field);
}

/** A public class may only construct one private feature delegate and forward unchanged calls. */
export function isPublicAssemblyFacade(node, context, wiring) {
  if (node.type !== "ClassDeclaration" || !identifier(node.id) || node.superClass || node.abstract || node.declare ||
      node.typeParameters || node.implements?.length || !undecorated(node)) {return false;}
  const fields = node.body.body.filter((item) => item.type === "PropertyDefinition");
  const constructors = node.body.body.filter((item) => item.type === "MethodDefinition" && item.kind === "constructor");
  const methods = node.body.body.filter((item) => item.type === "MethodDefinition" && item.kind === "method");
  if (fields.length !== 1 || constructors.length !== 1 || !methods.length || node.body.body.length !== methods.length + 2) {return false;}
  const field = fields[0];
  if (!privateDelegateField(field)) {return false;}
  return fieldConstructor(field, constructors[0], context, wiring) && methods.every((method) => forwardedMethod(method, field.key.name));
}
