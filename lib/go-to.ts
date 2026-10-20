/** Leaves the app for another page in this tab. A function of its own so component tests can replace it. */
export function goTo(url: string) {
  window.location.assign(url);
}
