// Starter template script — shows the live URL so the file->URL idea clicks.
(function () {
  var u = location.origin + location.pathname.replace(/index\.html$/, "");
  var el = document.getElementById("site-url");
  if (el) el.textContent = u;
  var demo = document.getElementById("demo-path");
  if (demo) demo.textContent = "hello.txt";
  console.log("%cWelcome to your new site! Edit index.html to make it yours.", "color:#1d4ed8;font-weight:bold");
})();
