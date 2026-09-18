// Flyout Menus
// Slides the whole menu window into place on open, WinUI flyout style.
// CSS cannot move a popup's OS window (the Mica backdrop lives on that window),
// so this nudges the window back by an offset and animates it with moveTo().
// It also tags the menu with [zen-flyout] so chrome.css can fade the contents.
(function () {
    // Settings
    let duration = 200;
    let offset   = 10;

    // Elements
    let root = document.documentElement;

    // WinUI decelerate curve, close to cubic-bezier(0.1, 0.9, 0.2, 1)
    function easeOut(progress) {
        return 1 - Math.pow(1 - progress, 3);
    }

    // Slide Menu Window Into Place
    function slideIn(popup) {
        let rect      = popup.getOuterScreenRect();
        let is_sub    = popup.parentNode && popup.parentNode.localName === "menu";
        let target_x  = rect.left;
        let target_y  = rect.top;
        let start_x   = is_sub ? target_x - offset : target_x;
        let start_y   = is_sub ? target_y : target_y - offset;
        let start     = performance.now();

        if (popup._zenFlyoutFrame) {
            cancelAnimationFrame(popup._zenFlyoutFrame);
        }

        popup.moveTo(start_x, start_y);

        function step(now) {
            if (popup.state !== "open" && popup.state !== "showing") {
                return;
            }

            let progress = Math.min((now - start) / duration, 1);
            let eased    = easeOut(progress);

            popup.moveTo(
                Math.round(start_x + (target_x - start_x) * eased),
                Math.round(start_y + (target_y - start_y) * eased)
            );

            if (progress < 1) {
                popup._zenFlyoutFrame = requestAnimationFrame(step);
            } else {
                popup._zenFlyoutFrame = null;
            }
        }

        popup._zenFlyoutFrame = requestAnimationFrame(step);
    }

    // Tag Menu On Open
    function onShowing(event) {
        if (event.target.localName === "menupopup") {
            event.target.setAttribute("zen-flyout", "");
        }
    }

    // Slide Once The Menu Has A Position
    function onShown(event) {
        if (event.target.localName === "menupopup" && !matchMedia("(prefers-reduced-motion)").matches) {
            slideIn(event.target);
        }
    }

    // Untag Menu On Close
    function onHidden(event) {
        let popup = event.target;
        if (popup.localName === "menupopup") {
            popup.removeAttribute("zen-flyout");
            if (popup._zenFlyoutFrame) {
                cancelAnimationFrame(popup._zenFlyoutFrame);
                popup._zenFlyoutFrame = null;
            }
        }
    }

    // Bind to Event Listeners
    root.addEventListener("popupshowing", onShowing, true);
    root.addEventListener("popupshown", onShown, true);
    root.addEventListener("popuphidden", onHidden, true);

    // Clean up when Sine disables or uninstalls the mod
    window.addUnloadListener?.(() => {
        root.removeEventListener("popupshowing", onShowing, true);
        root.removeEventListener("popupshown", onShown, true);
        root.removeEventListener("popuphidden", onHidden, true);
    });
})();
