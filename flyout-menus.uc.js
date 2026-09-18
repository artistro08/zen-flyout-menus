// Flyout Menus
// Rolls right-click menus out of nowhere the way Windows 11 (WinUI) flyouts
// do: the menu window's top edge stays put while the contents and backdrop
// slide down into view, clipped by the final bounds. 250ms, decelerate curve
// cubic-bezier(0, 0, 0, 1), measured frame by frame from the Edge context menu.
//
// How it works. Firefox cannot clip or hide a popup's OS window from CSS, and
// the Mica backdrop lives on that window, so this talks to Win32 through
// js-ctypes:
//   1. popupshowing: the popup's window already exists but is hidden. It is
//      cloaked (DWMWA_CLOAK) and given an off-window region so nothing shows
//      until the contents are painted. This is what removes the blank flash.
//   2. chrome.css sets appearance: none on menus so Firefox never applies the
//      Mica backdrop itself. The backdrop and rounded corners are applied here
//      instead, while the window is still cloaked.
//   3. Once the first paint is done the window region grows from the top
//      (SetWindowRgn) while the contents translate up to down, then the region
//      is cleared so DWM draws the normal rounded corners again.
(function () {
    // Settings
    let duration    = 250;
    let radius      = 8;
    let reduced     = matchMedia("(prefers-reduced-motion)").matches;
    let mica_popups = matchMedia("(-moz-windows-mica-popups)").matches;

    if (reduced || navigator.platform !== "Win32") {
        return;
    }

    // Win32
    let { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
    let user32     = ctypes.open("user32.dll");
    let gdi32      = ctypes.open("gdi32.dll");
    let dwmapi     = ctypes.open("dwmapi.dll");
    let HWND       = ctypes.voidptr_t;
    let HRGN       = ctypes.voidptr_t;
    let RECT       = new ctypes.StructType("RECT", [{ left: ctypes.int32_t }, { top: ctypes.int32_t }, { right: ctypes.int32_t }, { bottom: ctypes.int32_t }]);

    let FindWindowExW         = user32.declare("FindWindowExW", ctypes.winapi_abi, HWND, HWND, HWND, ctypes.char16_t.ptr, ctypes.char16_t.ptr);
    let GetWindow             = user32.declare("GetWindow", ctypes.winapi_abi, HWND, HWND, ctypes.uint32_t);
    let GetWindowRect         = user32.declare("GetWindowRect", ctypes.winapi_abi, ctypes.int32_t, HWND, RECT.ptr);
    let IsWindow              = user32.declare("IsWindow", ctypes.winapi_abi, ctypes.int32_t, HWND);
    let IsWindowVisible       = user32.declare("IsWindowVisible", ctypes.winapi_abi, ctypes.int32_t, HWND);
    let SetWindowRgn          = user32.declare("SetWindowRgn", ctypes.winapi_abi, ctypes.int32_t, HWND, HRGN, ctypes.int32_t);
    let CreateRectRgn         = gdi32.declare("CreateRectRgn", ctypes.winapi_abi, HRGN, ctypes.int32_t, ctypes.int32_t, ctypes.int32_t, ctypes.int32_t);
    let CreateRoundRectRgn    = gdi32.declare("CreateRoundRectRgn", ctypes.winapi_abi, HRGN, ctypes.int32_t, ctypes.int32_t, ctypes.int32_t, ctypes.int32_t, ctypes.int32_t, ctypes.int32_t);
    let DwmSetWindowAttribute = dwmapi.declare("DwmSetWindowAttribute", ctypes.winapi_abi, ctypes.int32_t, HWND, ctypes.uint32_t, ctypes.voidptr_t, ctypes.uint32_t);

    let GW_OWNER                       = 4;
    let DWMWA_CLOAK                    = 13;
    let DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    let DWMWA_SYSTEMBACKDROP_TYPE      = 38;
    let DWMWCP_ROUND                   = 2;
    let DWMSBT_TRANSIENTWINDOW         = 4;
    let POPUP_CLASS                    = "MozillaDropShadowWindowClass";

    // Elements
    let root      = document.documentElement;
    let main_hwnd = ctypes.cast(ctypes.uintptr_t(parseInt(window.docShell.treeOwner.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIAppWindow).docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).nativeHandle, 16)), HWND);
    let main_key  = String(ctypes.cast(main_hwnd, ctypes.uintptr_t).value);
    let windows   = new WeakMap();

    // cubic-bezier(0, 0, 0, 1): x = s^3, y = 3s^2 - 2s^3
    function ease(progress) {
        let s = Math.cbrt(progress);
        return 3 * s * s - 2 * s * s * s;
    }

    // Win32 Helpers
    function dwmInt(hwnd, attribute, value) {
        let boxed = ctypes.int32_t(value);
        DwmSetWindowAttribute(hwnd, attribute, boxed.address(), 4);
    }

    function isOurPopupWindow(hwnd) {
        return IsWindow(hwnd) && String(ctypes.cast(GetWindow(hwnd, GW_OWNER), ctypes.uintptr_t).value) === main_key;
    }

    function matchesRect(hwnd, rect, dpr) {
        let r = RECT();
        GetWindowRect(hwnd, r.address());
        return Math.abs(r.left - Math.round(rect.left * dpr)) <= 2 && Math.abs(r.top - Math.round(rect.top * dpr)) <= 2;
    }

    function findPopupWindow(test) {
        let hwnd = FindWindowExW(null, null, POPUP_CLASS, null);
        let n    = 0;
        while (!hwnd.isNull() && n++ < 500) {
            if (isOurPopupWindow(hwnd) && test(hwnd)) {
                return hwnd;
            }
            hwnd = FindWindowExW(null, hwnd, POPUP_CLASS, null);
        }
        return null;
    }

    // Hide a popup window completely: cloaked, and clipped to a spot outside itself
    function hideWindow(hwnd) {
        dwmInt(hwnd, DWMWA_CLOAK, 1);
        SetWindowRgn(hwnd, CreateRectRgn(-2, -2, -1, -1), 0);
    }

    function restoreWindow(hwnd) {
        SetWindowRgn(hwnd, null, 0);
        dwmInt(hwnd, DWMWA_CLOAK, 0);
    }

    // Roll The Menu Out
    function rollOut(popup) {
        let dpr = window.devicePixelRatio;

        // Force layout so the popup window is positioned at its final spot
        popup.getBoundingClientRect();

        if (popup.state !== "open" && popup.state !== "showing") {
            if (popup._zenFlyoutGuess) {
                restoreWindow(popup._zenFlyoutGuess);
            }
            popup._zenFlyoutGuess = null;
            return;
        }

        let rect  = popup.getOuterScreenRect();
        let guess = popup._zenFlyoutGuess;
        let hwnd  = guess && matchesRect(guess, rect, dpr) ? guess : findPopupWindow(h => matchesRect(h, rect, dpr));

        popup._zenFlyoutGuess = null;

        if (guess && hwnd !== guess) {
            restoreWindow(guess);
            if (hwnd) {
                hideWindow(hwnd);
            }
        }

        if (!hwnd) {
            return;
        }

        windows.set(popup, hwnd);

        if (mica_popups) {
            dwmInt(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, DWMSBT_TRANSIENTWINDOW);
            dwmInt(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND);
        }

        let inner      = popup.shadowRoot && popup.shadowRoot.querySelector("[part~=content]");
        let width      = Math.round(rect.width * dpr);
        let height     = Math.round(rect.height * dpr);
        let height_css = rect.height;
        let diameter   = Math.round(radius * dpr) * 2;
        let start      = null;
        let previous   = 0;
        let revealed   = false;

        function clip(eased) {
            let h = Math.round(height * eased);
            SetWindowRgn(hwnd, h > 0 ? CreateRoundRectRgn(0, 0, width + 1, h + 1, diameter, diameter) : CreateRectRgn(-2, -2, -1, -1), 1);
        }

        if (inner) {
            inner.style.translate = "0 " + (-height_css) + "px";
        }

        function step(now) {
            if (popup.state !== "open" && popup.state !== "showing") {
                return;
            }

            if (start === null) {
                start = now;
            }

            let progress = Math.min((now - start) / duration, 1);
            let eased    = ease(progress);

            // The clip lands one screen refresh before the repaint, so it trails by a frame
            clip(previous);

            if (previous > 0 && !revealed) {
                revealed = true;
                dwmInt(hwnd, DWMWA_CLOAK, 0);
            }

            previous = eased;

            if (inner) {
                inner.style.translate = "0 " + ((eased - 1) * height_css) + "px";
            }

            if (progress < 1) {
                popup._zenFlyoutFrame = requestAnimationFrame(step);
            } else {
                popup._zenFlyoutFrame = requestAnimationFrame(() => {
                    popup._zenFlyoutFrame = null;
                    SetWindowRgn(hwnd, null, 1);
                    if (inner) {
                        inner.style.translate = "";
                    }
                });
            }
        }

        // Let the first (still hidden) paint finish before rolling
        popup._zenFlyoutFrame = requestAnimationFrame(step);
    }

    // Hide The Menu Window Before It Shows
    function onShowing(event) {
        let popup = event.target;
        if (popup.localName !== "menupopup") {
            return;
        }

        // The window is created before this event. Use the one seen last time, else the newest hidden one.
        let guess = windows.get(popup);
        if (!guess || !isOurPopupWindow(guess)) {
            guess = findPopupWindow(h => !IsWindowVisible(h));
        }

        if (guess) {
            hideWindow(guess);
        }

        popup._zenFlyoutGuess = guess;
        popup._zenFlyoutFrame = requestAnimationFrame(() => rollOut(popup));
    }

    // Put The Menu Window Back To Normal On Close
    function onHidden(event) {
        let popup = event.target;
        if (popup.localName !== "menupopup") {
            return;
        }

        if (popup._zenFlyoutFrame) {
            cancelAnimationFrame(popup._zenFlyoutFrame);
            popup._zenFlyoutFrame = null;
        }

        let inner = popup.shadowRoot && popup.shadowRoot.querySelector("[part~=content]");
        if (inner) {
            inner.style.translate = "";
        }

        let hwnd = windows.get(popup);
        if (hwnd && isOurPopupWindow(hwnd)) {
            restoreWindow(hwnd);
        }

        if (popup._zenFlyoutGuess) {
            restoreWindow(popup._zenFlyoutGuess);
            popup._zenFlyoutGuess = null;
        }
    }

    // Bind to Event Listeners
    root.setAttribute("zen-flyout-ready", "");
    root.addEventListener("popupshowing", onShowing, true);
    root.addEventListener("popuphidden", onHidden, true);

    // Clean up when Sine disables or uninstalls the mod
    window.addUnloadListener?.(() => {
        root.removeAttribute("zen-flyout-ready");
        root.removeEventListener("popupshowing", onShowing, true);
        root.removeEventListener("popuphidden", onHidden, true);
        user32.close();
        gdi32.close();
        dwmapi.close();
    });
})();
