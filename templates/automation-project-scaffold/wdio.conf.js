// ponytail: capabilities below are placeholders (a device/emulator name and app path only
// the QA engineer running this locally can fill in) — update deviceName, platformVersion,
// and app before the first `npm test`.
exports.config = {
  runner: "local",
  specs: ["./tests/**/*.spec.js"],
  maxInstances: 1,

  capabilities: [
    {
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:deviceName": "REPLACE_ME", // e.g. an emulator AVD name or connected device id
      "appium:platformVersion": "REPLACE_ME",
      "appium:app": "REPLACE_ME", // absolute path to the built .apk/.aab
    },
  ],

  logLevel: "info",
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,

  services: ["appium"],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 60000,
  },
};
