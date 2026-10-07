/**
 * The browser half's inject set, in a module that imports nothing.
 *
 * cordis resolves `ctx.<name>` through the fiber's inject set and throws
 * `cannot get property "<name>" without inject` **at the moment of access**, and
 * a `try/catch` wrapped around a navigation call turns that throw into silence —
 * a button that does nothing at all. So every service the browser half touches
 * belongs here, and the list lives apart from the components only so a test can
 * assert it without importing React or the shell's frozen module table.
 *
 * `ctx.effect` is not listed: it is cordis itself, like `ctx.logger` and
 * `ctx.get`, not a service another plugin provides.
 */

/** Every service `apply` reaches for, in one place. */
export const CLIENT_SERVICES = ['slots', 'sidebarRightTabs', 'sidebarRight'] as const
