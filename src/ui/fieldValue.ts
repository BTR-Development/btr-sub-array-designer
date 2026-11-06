/**
 * What an optional number field is worth while it is being typed.
 *
 * Max SPL is the expensive one: `resolve` makes it a source's `refSplDb`, which
 * is a DRIVE LEVEL, so whatever lands here ends up in the complex amplitude the
 * engine sums. A NaN there is refused by `unsolvable` and the user gets no map.
 *
 * What kept that from happening was the browser rather than this code: a number
 * input reports "" for a value it considers invalid, so "-" and "1e" arrived
 * here already empty and the `=== ''` test caught them. That is a behaviour of
 * the control, not a rule of ours, and it holds only as long as the control
 * stays `type="number"`. The rule of ours is the one the speaker data policy
 * states everywhere else: a field that cannot be parsed has confirmed nothing,
 * and unconfirmed is null — never NaN, which is a number and therefore survives
 * every check between here and the solve.
 */
export function optionalNumber(raw: string): number | '' {
  // `Number` rather than `parseFloat`, which stops at the first character it
  // cannot use: it reads "1e" as 1 and "136 dB" as 136, which is a figure the
  // user did not enter being treated as one they did.
  const text = raw.trim();
  if (text === '') return '';
  const v = Number(text);
  return isFinite(v) ? v : '';
}
