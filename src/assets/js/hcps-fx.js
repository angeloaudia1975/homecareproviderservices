/* ==========================================================================
   HCPS shared interaction layer — scroll-reveal entrance animations.
   Loaded once site-wide from base.njk. Works two ways:
     1) Automatically on common building blocks (headings, cards, CTA blocks).
     2) On any element carrying a  data-reveal="up|down|left|right|fade"  attribute.
   Runs each reveal ONCE, and is fully disabled for reduced-motion users.
   The paired CSS lives in site.css (search: "HCPS shared FX layer").
   ========================================================================== */
(function () {
  var SEL = [
    "[data-reveal]",
    ".section-head", ".rep-copy",
    ".manu-grid .manu-card",
    ".team-grid .team-card",
    ".testimonial-grid .testimonial-card",
    ".why-grid article",
    ".mfp-pill"
  ].join(",");

  var els = [].slice.call(document.querySelectorAll(SEL));
  if (!els.length) return;

  var reduce = false;
  try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  // No motion (or no observer support): show everything immediately, no animation.
  if (reduce || !("IntersectionObserver" in window)) {
    els.forEach(function (el) { el.classList.add("is-in"); });
    return;
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting) { en.target.classList.add("is-in"); io.unobserve(en.target); }
    });
  }, { threshold: 0.1, rootMargin: "0px 0px -8% 0px" });

  els.forEach(function (el) { io.observe(el); });
})();
