import { continueRender, delayRender, staticFile } from "remotion";

// «Polka Sans» is IBM Plex Sans (apps/web/public/fonts); the renderer waits for both faces.
const handle = typeof document !== "undefined" ? delayRender("Polka Sans") : null;
if (typeof document !== "undefined") {
  const faces = [
    new FontFace("Polka Sans", `url(${staticFile("fonts/IBMPlexSans-Regular.woff2")}) format("woff2")`, { weight: "400" }),
    new FontFace("Polka Sans", `url(${staticFile("fonts/IBMPlexSans-SemiBold.woff2")}) format("woff2")`, { weight: "500 800" }),
  ];
  Promise.all(faces.map((face) => face.load()))
    .then((loaded) => {
      for (const face of loaded) document.fonts.add(face);
      continueRender(handle!);
    })
    .catch(() => continueRender(handle!));
}
