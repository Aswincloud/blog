/* Aswin's Homelab — progressive enhancement.
   Theme is already applied pre-paint by the inline snippet in <head>. */
(function () {
  "use strict";

  var root = document.documentElement;

  /* ---- Theme toggle ------------------------------------------------------ */
  function currentTheme() {
    return root.getAttribute("data-theme") === "light" ? "light" : "dark";
  }

  function setMeta(theme) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? "#fbfcfe" : "#0b0f16");
  }

  function applyTheme(theme, persist) {
    root.setAttribute("data-theme", theme);
    setMeta(theme);
    var btn = document.querySelector(".theme-toggle");
    if (btn) btn.setAttribute("aria-label", "Switch to " + (theme === "light" ? "dark" : "light") + " theme");
    if (persist) {
      try {
        localStorage.setItem("theme", theme);
      } catch (e) {}
    }
  }

  var toggle = document.querySelector(".theme-toggle");
  if (toggle) {
    applyTheme(currentTheme(), false); // sync aria-label + meta
    toggle.addEventListener("click", function () {
      applyTheme(currentTheme() === "light" ? "dark" : "light", true);
    });
  }

  /* Follow the OS if the user never made an explicit choice. */
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: light)");
    var onChange = function (e) {
      var stored = null;
      try {
        stored = localStorage.getItem("theme");
      } catch (err) {}
      if (!stored) applyTheme(e.matches ? "light" : "dark", false);
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  /* ---- Copy code --------------------------------------------------------- */
  var COPY_RESET = 1800;
  document.querySelectorAll(".codeblock__copy").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var block = btn.closest(".codeblock");
      var code = block && block.querySelector("pre");
      if (!code) return;
      var text = code.innerText.replace(/\n$/, "");

      var done = function () {
        btn.classList.add("is-copied");
        var label = btn.querySelector(".label");
        var prev = label ? label.textContent : null;
        if (label) label.textContent = "Copied";
        setTimeout(function () {
          btn.classList.remove("is-copied");
          if (label && prev !== null) label.textContent = prev;
        }, COPY_RESET);
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () {
          fallbackCopy(text, done);
        });
      } else {
        fallbackCopy(text, done);
      }
    });
  });

  function fallbackCopy(text, done) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "absolute";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } catch (e) {}
    document.body.removeChild(ta);
  }

  /* ---- Reading progress -------------------------------------------------- */
  var bar = document.querySelector(".progress__bar");
  if (bar) {
    var ticking = false;
    var update = function () {
      var doc = document.documentElement;
      var scrollable = doc.scrollHeight - doc.clientHeight;
      var ratio = scrollable > 0 ? doc.scrollTop / scrollable : 0;
      bar.style.transform = "scaleX(" + Math.min(1, Math.max(0, ratio)) + ")";
      ticking = false;
    };
    var onScroll = function () {
      if (!ticking) {
        window.requestAnimationFrame(update);
        ticking = true;
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    update();
  }
})();
