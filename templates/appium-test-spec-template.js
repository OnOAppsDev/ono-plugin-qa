// Shape `automation-test-writer` follows for every generated spec file:
// automation/tests/<feature-slug>/<feature-slug>.spec.js
//
// - One `describe` per feature.
// - One `it()` per test-plan.md row, named "<id> - <summary>" so a failure traces
//   straight back to that row.
// - Page objects (imported below) hold locators and actions; the spec composes them.

const LoginPage = require("../../pages/LoginPage");

describe("<feature-name>", () => {
  it("TC1 - <summary from test-plan.md>", async () => {
    await LoginPage.open();
    await LoginPage.enterEmail("test@example.com");
    await LoginPage.enterPassword("correct-password");
    await LoginPage.submit();

    await expect(LoginPage.welcomeText).toBeDisplayed();
  });

  it("EC1 - <summary from test-plan.md>", async () => {
    // TODO: needs a stable testID — see src/screens/Login/PasswordField.tsx
  });
});
