/** Smooth scrolling only for people who have not asked the system to reduce motion. */
export function scrollBehavior(): ScrollBehavior {
  return typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}
