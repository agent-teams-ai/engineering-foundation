import assert from "node:assert/strict";
import { createConnection } from "node:net";

export async function openRawFixtureSocket(boundary, context) {
  const socket = createConnection({
    host: boundary.environment.QGR_FIXTURE_HOST,
    port: Number.parseInt(boundary.environment.QGR_FIXTURE_PORT, 10),
  });
  const closed = onceSocket(socket, "close");
  context.after(async () => { socket.destroy(); await closed; });
  socket.on("error", () => {});
  await onceSocket(socket, "connect");
  return { closed, socket };
}

function onceSocket(socket, event) {
  return new Promise((resolve) => { socket.once(event, resolve); });
}

function readSocketLine(socket) {
  return new Promise((resolve, reject) => {
    let source = "";
    const onClose = () => { reject(new Error("Socket closed before a complete line.")); };
    const onData = (chunk) => {
      source += chunk;
      const newline = source.indexOf("\n");
      if (newline !== -1) {
        socket.off("close", onClose);
        socket.off("data", onData);
        resolve(source.slice(0, newline + 1));
      }
    };
    socket.once("close", onClose);
    socket.on("data", onData);
  });
}

export async function registerRawFixtureRole(boundary, role, context) {
  const { closed, socket } = await openRawFixtureSocket(boundary, context);
  socket.setEncoding("utf8");
  const acknowledged = readSocketLine(socket);
  const environment = boundary.environmentFor(role);
  socket.write(`${JSON.stringify({
    boundaryId: environment.QGR_FIXTURE_BOUNDARY_ID,
    credential: environment.QGR_FIXTURE_CREDENTIAL,
  })}\n`);
  assert.equal(
    await acknowledged,
    `${JSON.stringify({
      boundaryId: boundary.evidenceId,
      command: "registered",
      role,
    })}\n`,
  );
  return { closed, socket };
}
