// Flyout Menus
// Firefox keeps a menu's layout alive after it closes, so a CSS animation only
// plays on the first open. This tags each menu while it is open so the
// animation in chrome.css restarts every time.
(function () {
    // Elements
    let root = document.documentElement;

    // Tag Menu On Open
    function tagMenu(event) {
        if (event.target.localName === "menupopup") {
            event.target.setAttribute("zen-flyout", "");
        }
    }

    // Untag Menu On Close
    function untagMenu(event) {
        if (event.target.localName === "menupopup") {
            event.target.removeAttribute("zen-flyout");
        }
    }

    // Bind to Event Listeners
    root.addEventListener("popupshowing", tagMenu, true);
    root.addEventListener("popuphidden", untagMenu, true);

    // Clean up when Sine disables or uninstalls the mod
    window.addUnloadListener?.(() => {
        root.removeEventListener("popupshowing", tagMenu, true);
        root.removeEventListener("popuphidden", untagMenu, true);
    });
})();
