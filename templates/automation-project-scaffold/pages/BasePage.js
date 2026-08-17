// Shared helpers every page object builds on. Keep this file thin — behavior specific
// to one screen belongs in that screen's own page object, not here.
class BasePage {
  async switchToWebview() {
    const contexts = await driver.getContexts();
    const webview = contexts.find((c) => String(c).toLowerCase().includes("webview"));
    if (!webview) {
      throw new Error(`No WEBVIEW context available. Contexts seen: ${contexts.join(", ")}`);
    }
    await driver.switchContext(webview);
  }

  async switchToNative() {
    await driver.switchContext("NATIVE_APP");
  }
}

module.exports = BasePage;
