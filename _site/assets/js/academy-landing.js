/* Training Academy landing page: the depth-hero tilt (desktop pointer only; respects reduced motion — CLAUDE.md §1). */
(function () {
  var reduce = false; try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
  if (reduce) return;
  Array.prototype.forEach.call(document.querySelectorAll(".ta-tilt"), function (el) {
    var band = el.closest(".ta-hero") || el; var g = el.querySelector(".ta-glare");
    band.addEventListener("mousemove", function (e) {
      var b = el.getBoundingClientRect();
      var px = Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)), py = Math.max(0, Math.min(1, (e.clientY - b.top) / b.height));
      el.style.transform = "perspective(1500px) rotateY(" + ((px - .5) * 12) + "deg) rotateX(" + ((.5 - py) * 8) + "deg) translateZ(18px)";
      if (g) { g.style.setProperty("--mx", (px * 100) + "%"); g.style.setProperty("--my", (py * 100) + "%"); g.style.opacity = "1"; }
    });
    band.addEventListener("mouseleave", function () { el.style.transform = "perspective(1500px) rotateY(0) rotateX(0)"; if (g) g.style.opacity = "0"; });
  });
})();
