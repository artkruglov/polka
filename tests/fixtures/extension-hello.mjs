// A minimal extension for tests/extensions.test.ts: loaded by path.
export default {
  name: "hello",
  register(app) {
    app.get("/api/ext/hello", async () => ({ hello: "world" }));
  },
};
