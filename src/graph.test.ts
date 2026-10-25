import { test } from "node:test";
import assert from "node:assert/strict";
import { latestMap, layers, parseDeps, ranks } from "./graph.ts";

const node = (id: string, needs: string[] = []) => ({ id, label: id, icon: "atom", summary: "", needs });

test("ranks put each node one column past its deepest dependency", () => {
  const nodes = parseDeps(JSON.stringify({ nodes: [node("goal", ["b", "c"]), node("a"), node("b", ["a"]), node("c", ["a", "b"])] }));
  assert.deepEqual(Object.fromEntries(ranks(nodes)), { a: 0, b: 1, c: 2, goal: 3 });
});

test("parseDeps rejects broken graphs", () => {
  assert.throws(() => parseDeps(JSON.stringify({ nodes: [node("a", ["b"]), node("b", ["a"])] })), /cycle/);
  assert.throws(() => parseDeps(JSON.stringify({ nodes: [node("a", ["ghost"])] })), /unknown id/);
  assert.throws(() => parseDeps("{not json"));
});

test("layers pull roots down, give row-skipping edges a lane, and order rows under parents", () => {
  const nodes = parseDeps(
    JSON.stringify({
      nodes: [node("int"), node("contra"), node("odd", ["int"]), node("even", ["int"]), node("sq", ["even"]), node("q", ["int"]), node("goal", ["sq", "q", "contra"])],
    }),
  );
  const { rows, edges } = layers(nodes);
  assert.deepEqual(
    rows.map((row) => row.map((n) => n.id)),
    [["int"], ["odd", "even", "int>q@1"], ["sq", "q", "contra"], ["goal"]],
  );
  assert.deepEqual(edges.find((e) => e.to === "q")!.chain, ["int", "int>q@1", "q"]);
  assert.equal(edges.length, 7);
});

test("latestMap takes the last valid deps block from the tutor", () => {
  const block = (...ids: string[]) => "```deps\n" + JSON.stringify({ nodes: ids.map((id) => node(id)) }) + "\n```";
  const messages = [
    { role: "assistant", content: `Plan:\n\n${block("a")}` },
    { role: "user", content: block("fake") },
    { role: "assistant", content: `${block("b")}\n\nand\n\n\`\`\`deps\n{broken\n\`\`\`` },
  ];
  assert.deepEqual(latestMap(messages)?.map((n) => n.id), ["b"]);
  assert.deepEqual(latestMap(messages.slice(0, 2))?.map((n) => n.id), ["a"]);
  assert.equal(latestMap([]), null);
});
