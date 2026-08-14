/**
 * A temporary password somebody has to read out loud.
 *
 * Two short words and three digits: it gets said across a desk, written on a
 * slip, or typed by an eight-year-old from a note, and a random string of
 * symbols fails all three. The server's policy is length plus a digit plus a
 * common-password screen, which this satisfies without being a puzzle.
 *
 * It is only ever a suggestion - every field it fills stays editable - and
 * whoever receives it is made to choose their own at first sign-in.
 */
const WORDS = ['blue', 'star', 'moon', 'lion', 'tree', 'wave', 'gold', 'rain'];

export function suggestPassword(): string {
  const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  return `${pick()}${pick()}${Math.floor(100 + Math.random() * 900)}`;
}
