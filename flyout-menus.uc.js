// Flyout Menus
// Slides the whole menu window into place on open, matching the Windows 11
// tray flyout: 60px travel, 330ms, decelerate curve cubic-bezier(0, 0, 0, 1).
// CSS cannot move a popup's OS window (the Mica backdrop lives on that window),
// so this nudges the window back and animates it with moveTo().
(function () {
    // Settings
    let duration = 330;
    let offset   = 60;

    // Elements
    let root = document.documentElement;

    // cubic-bezier(0, 0, 0, 1): x = s^3, y = 3s^2 - 2s^3
    function ease(progress) {
        let s = Math.cbrt(progress);
        return 3 * s * s - 2 * s * s * s;
    }

    // Slide Menu Window Into Place
    function slideIn(popup) {
        let rect     = popup.getOuterScreenRect();
        let is_sub   = popup.parentNode && popup.parentNode.localName === "menu";
        let target_x = rect.left;
        let target_y = rect.top;
        let start_x  = is_sub ? target_x - offset : target_x;
        let start_y  = is_sub ? target_y : target_y - offset;
        let start    = null;

        popup.moveTo(start_x, start_y);

        function step(now) {
            if (popup.state !== "open" && popup.state !== "showing") {
                return;
            }

            if (start === null) {
                start = now;
            }

            let progress = Math.min((now - start) / duration, 1);
            let eased    = ease(progress);

            popup.moveTo(
                Math.round(start_x + (target_x - start_x) * eased),
                Math.round(start_y + (target_y - start_y) * eased)
            );

            popup._zenFlyoutFrame = progress < 1 ? requestAnimationFrame(step) : null;
        }

        popup._zenFlyoutFrame = requestAnimationFrame(step);
    }

    // Slide Once The Menu Has A Position
    function onShown(event) {
        let popup = event.target;
        if (popup.localName !== "menupopup" || matchMedia("(prefers-reduced-motion)").matches) {
            return;
        }

        if (popup._zenFlyoutFrame) {
            cancelAnimationFrame(popup._zenFlyoutFrame);
        }

        slideIn(popup);
    }

    // Stop Sliding On Close
    function onHidden(event) {
        let popup = event.target;
        if (popup.localName === "menupopup" && popup._zenFlyoutFrame) {
            cancelAnimationFrame(popup._zenFlyoutFrame);
            popup._zenFlyoutFrame = null;
        }
    }

    // Bind to Event Listeners
    root.addEventListener("popupshown", onShown, true);
    root.addEventListener("popuphidden", onHidden, true);

    // Clean up when Sine disables or uninstalls the mod
    window.addUnloadListener?.(() => {
        root.removeEventListener("popupshown", onShown, true);
        root.removeEventListener("popuphidden", onHidden, true);
    });
})();
