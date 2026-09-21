#!/usr/bin/env node

const image = process.argv[2] ?? process.env.POLKA_IMAGE ?? "";
if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(image)) {
  console.error("POLKA_IMAGE must be an image reference pinned by a lowercase sha256 digest");
  process.exitCode = 2;
} else {
  console.log("POLKA_IMAGE digest format accepted");
}
