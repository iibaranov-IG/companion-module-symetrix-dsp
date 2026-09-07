const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const { test } = require("node:test");

// Capture the production class through its existing entrypoint. Only the
// Companion host is replaced: no socket or running Companion is needed.
function createInstance() {
  let Instance;
  const filename = join(__dirname, "..", "index.js");
  runInNewContext(
    readFileSync(filename, "utf8"),
    {
      require(id) {
        if (id === "@companion-module/base") {
          return {
            InstanceBase: class {},
            runEntrypoint(instance) {
              Instance = instance;
            },
          };
        }
        // These definition factories are not used by setControlNumberVariable.
        if (["./presets", "./actions", "./feedbacks"].includes(id)) return {};
        throw new Error(`Unexpected dependency: ${id}`);
      },
    },
    { filename },
  );
  const instance = new Instance();
  instance.states = {};
  instance.variables = [
    { variableId: "connected", name: "Companion connected to DSP (boolean)" },
    { variableId: "last_preset", name: "Last recalled preset" },
  ];
  instance.definitionCalls = [];
  instance.valueCalls = [];
  instance.feedbackCalls = [];
  instance.setVariableDefinitions = (definitions) =>
    instance.definitionCalls.push(structuredClone(definitions));
  instance.setVariableValues = (values) =>
    instance.valueCalls.push(structuredClone(values));
  instance.checkFeedbacks = (...ids) => instance.feedbackCalls.push(ids);
  return instance;
}

test("first controller update adds exactly three stable variable IDs", () => {
  const instance = createInstance();
  instance.setControlNumberVariable(7, 0);
  assert.deepEqual(
    instance.variables.map(({ variableId }) => variableId),
    [
      "connected",
      "last_preset",
      "control_number_7",
      "control_number_7_db",
      "control_number_7_perc",
    ],
  );
  assert.equal(instance.definitionCalls.length, 1);
  assert.deepEqual(instance.valueCalls[0], {
    control_number_7: 0,
    control_number_7_perc: "0.0%",
    control_number_7_db: "Off",
  });
});

test("500 updates reuse definitions but continue publishing values and feedbacks", () => {
  const instance = createInstance();
  for (let value = 0; value < 500; value++)
    instance.setControlNumberVariable(7, value);
  assert.equal(instance.variables.length, 5);
  assert.equal(instance.definitionCalls.length, 1);
  assert.equal(instance.valueCalls.length, 500);
  assert.equal(instance.states.control_number_7, 499);
  assert.equal(instance.valueCalls[499].control_number_7, 499);
  assert.equal(instance.feedbackCalls.length, 500);
  assert.ok(
    instance.feedbackCalls.every(
      (ids) => ids.length === 1 && ids[0] === "on_off_value",
    ),
  );
});

test("interleaved controllers each register once without overwriting each other", () => {
  const instance = createInstance();
  for (const value of [0, 100, 65535]) {
    instance.setControlNumberVariable(1, value);
    instance.setControlNumberVariable(10, 65535 - value);
  }
  assert.equal(instance.variables.length, 8);
  assert.equal(
    new Set(instance.variables.map(({ variableId }) => variableId)).size,
    8,
  );
  assert.equal(instance.definitionCalls.length, 2);
  assert.equal(instance.states.control_number_1, 65535);
  assert.equal(instance.states.control_number_10, 0);
});

test("changing a display name does not cause duplicate registration", () => {
  const instance = createInstance();
  instance.setControlNumberVariable(7, 0);
  instance.variables.find(
    ({ variableId }) => variableId === "control_number_7",
  ).name = "Renamed display label";
  instance.setControlNumberVariable(7, 65535);
  assert.equal(instance.variables.length, 5);
  assert.equal(instance.definitionCalls.length, 1);
});

test("a coincidentally matching display name does not hide a missing controller ID", () => {
  const instance = createInstance();
  instance.variables.push({
    variableId: "unrelated",
    name: "control_number_7",
  });
  instance.setControlNumberVariable(7, 65535);
  assert.ok(
    instance.variables.some(
      ({ variableId }) => variableId === "control_number_7",
    ),
  );
  assert.equal(instance.definitionCalls.length, 1);
});

test("endpoint formatting and on/off feedback are preserved across repeated updates", () => {
  const instance = createInstance();
  const feedbacks = require("../feedbacks").getFeedbacks(instance);
  const feedback = { options: { control_number: 7 } };
  instance.setControlNumberVariable(7, 65535);
  assert.deepEqual(instance.valueCalls[0], {
    control_number_7: 65535,
    control_number_7_perc: "100.0%",
    control_number_7_db: "+12.0 dB",
  });
  assert.equal(feedbacks.on_off_value.callback(feedback), true);
  instance.setControlNumberVariable(7, 0);
  assert.equal(feedbacks.on_off_value.callback(feedback), false);
  assert.equal(instance.valueCalls[1].control_number_7_db, "Off");
});
