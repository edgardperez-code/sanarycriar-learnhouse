// Sanar y Criar: the name a signed-in user sees for herself (the header
// menu, the dashboard menus and greetings, the AI greetings). Sign-up no
// longer asks for a username: the API makes one up ("mariapena583735",
// services/users/sc_username.py) that means nothing to her, so these spots
// show her first name, and the username only when the account has none.
// Pure logic (no React, no Next) so tests can import it.

export type NamedUser =
  | {
      first_name?: string | null
      username?: string | null
    }
  | null
  | undefined

/** «María»; the username when the account has no first name; else "". */
export function ownDisplayName(user: NamedUser): string {
  const first = typeof user?.first_name === 'string' ? user.first_name.trim() : ''
  if (first) return first
  return typeof user?.username === 'string' ? user.username.trim() : ''
}
