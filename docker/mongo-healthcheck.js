// Idempotent single-node initialization for this local/demo Compose stack.
// A successful initiation alone is not readiness: election must finish first.
try {
  const status = db.adminCommand({ replSetGetStatus: 1 });
  if (status.set !== "rs0") throw new Error("Expected replica set rs0");
} catch (error) {
  if (error.code !== 94) throw error; // NotYetInitialized only
  const result = rs.initiate({
    _id: "rs0",
    members: [{ _id: 0, host: "mongodb:27017" }],
  });
  if (!result.ok) throw new Error("Could not initialize replica set");
}

const hello = db.adminCommand({ hello: 1 });
if (hello.setName !== "rs0" || !hello.isWritablePrimary) quit(1);
quit(0);
