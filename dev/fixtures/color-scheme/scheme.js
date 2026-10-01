// What each mechanism on this page concluded: "light" or "dark". `jsAtStartup`
// is what matchMedia said when this script first ran (as a site deciding its
// theme in JS at load would see it); `jsNow` asks again.
const query = "(prefers-color-scheme: dark)";
const jsAtStartup = matchMedia(query).matches ? "dark" : "light";

window.__scheme = () => {
  const prop = (id) => getComputedStyle(document.getElementById(id)).getPropertyValue("--scheme").trim();
  return {
    mediaSame: prop("media-same"),
    mediaCross: prop("media-cross"),
    linkMedia: prop("link-media"),
    lightDark: getComputedStyle(document.getElementById("light-dark")).color === "rgb(2, 2, 2)" ? "dark" : "light",
    jsAtStartup,
    jsNow: matchMedia(query).matches ? "dark" : "light",
    picture: document.getElementById("picture").currentSrc.endsWith("dark.svg") ? "dark" : "light",
    marker: document.documentElement.getAttribute("data-atelier-marker"),
  };
};
