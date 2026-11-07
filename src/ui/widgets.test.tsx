// @vitest-environment jsdom
/**
 * The numeric field's contract.
 *
 * It commits on Enter and on leaving, Escape abandons, the arrows step and a
 * comma is a decimal point. Each of those replaced a specific behaviour that
 * was wrong in a specific way, and the cases below are written against the
 * wrongness rather than the implementation: a field that commits per keystroke
 * fails the first group, and one without Escape fails the second.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { NumField } from './widgets';

afterEach(cleanup);

const field = () => screen.getByRole('textbox') as HTMLInputElement;

function mount(props: Partial<React.ComponentProps<typeof NumField>> = {}) {
  const onChange = vi.fn();
  render(<NumField value={props.value ?? 10} onChange={props.onChange ?? onChange} {...props} />);
  return onChange;
}

describe('when the number reaches the model', () => {
  it('is not while it is being typed', () => {
    // "180" used to arrive as 1, then 18, then 180: three writes, three
    // recomputes and three undo steps to walk back through.
    const onChange = mount({ value: 0 });
    fireEvent.change(field(), { target: { value: '1' } });
    fireEvent.change(field(), { target: { value: '18' } });
    fireEvent.change(field(), { target: { value: '180' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(field());
    expect(onChange.mock.calls).toEqual([[180]]);
  });

  it('is on Enter, without having to leave the field', () => {
    // Typed a digit at a time, so a field that committed per keystroke would
    // record [[4], [42]] and fail here rather than passing on the last write.
    const onChange = mount({ value: 0 });
    fireEvent.change(field(), { target: { value: '4' } });
    fireEvent.change(field(), { target: { value: '42' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onChange.mock.calls).toEqual([[42]]);
    // and the field is still open for more, which is the point of Enter
    fireEvent.change(field(), { target: { value: '43' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onChange.mock.calls).toEqual([[42], [43]]);
  });

  it('is never, for a field that was only visited', () => {
    // Tabbing through a panel must not write anything. Each no-op write is an
    // undo step that does nothing when you take it.
    const onChange = mount({ value: 7.5 });
    fireEvent.focus(field());
    fireEvent.blur(field());
    expect(onChange).not.toHaveBeenCalled();
    // and retyping the same number is the same non-edit
    fireEvent.change(field(), { target: { value: '7.5' } });
    fireEvent.blur(field());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is never, for text that is not a number', () => {
    const onChange = mount({ value: 3 });
    for (const junk of ['', '-', 'abc', '.']) {
      fireEvent.change(field(), { target: { value: junk } });
      fireEvent.blur(field());
      expect(onChange, junk).not.toHaveBeenCalled();
      expect(field().value, junk).toBe('3');
    }
  });
});

describe('getting out of a half-typed field', () => {
  it('puts the old number back on Escape and writes nothing', () => {
    const onChange = mount({ value: 12 });
    fireEvent.change(field(), { target: { value: '999' } });
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(field().value).toBe('12');
    expect(onChange).not.toHaveBeenCalled();
    // and the blur that Escape causes must not then commit the abandoned text
    fireEvent.blur(field());
    expect(onChange).not.toHaveBeenCalled();
    expect(field().value).toBe('12');
  });
});

describe('the limits', () => {
  it('are applied once, at the commit, not to what is being typed', () => {
    // With a per-keystroke commit a field with min 1 could not be given 0.5:
    // the 0 arrived first and was clamped under the cursor.
    const onChange = mount({ value: 2, min: 1, max: 10 });
    fireEvent.change(field(), { target: { value: '0' } });
    fireEvent.change(field(), { target: { value: '0.' } });
    fireEvent.change(field(), { target: { value: '0.5' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(field());
    expect(onChange.mock.calls).toEqual([[1]]);
  });

  it('show what was taken, not what was asked for', () => {
    mount({ value: 2, min: 1, max: 10 });
    fireEvent.change(field(), { target: { value: '400' } });
    fireEvent.blur(field());
    expect(field().value).toBe('10');
  });
});

describe('a comma', () => {
  it('is a decimal point, because here it is', () => {
    // Which separator a `type="number"` input accepts is the machine's
    // locale's business; parsing the text ourselves makes both work on any
    // machine the build is carried to.
    const onChange = mount({ value: 0 });
    fireEvent.change(field(), { target: { value: '1,5' } });
    fireEvent.blur(field());
    expect(onChange.mock.calls).toEqual([[1.5]]);
    expect(field().value).toBe('1.5');
  });
});

describe('the arrow keys', () => {
  it('step by one step, and by ten with Shift', () => {
    const onChange = mount({ value: 10, step: 0.5 });
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    expect(onChange.mock.calls.at(-1)).toEqual([10.5]);
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    // from the text the previous step left, not from the stale prop
    expect(onChange.mock.calls.at(-1)).toEqual([10]);
    fireEvent.keyDown(field(), { key: 'ArrowUp', shiftKey: true });
    expect(onChange.mock.calls.at(-1)).toEqual([15]);
  });

  it('respect the limits', () => {
    const onChange = mount({ value: 10, step: 1, max: 10 });
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    expect(onChange.mock.calls).toEqual([[10]]);
  });
});

describe('a selection that disagrees with itself', () => {
  it('shows nothing until a number is typed, and then commits it', () => {
    const onChange = mount({ value: 0, mixed: true });
    expect(field().value).toBe('');
    // 0 is the value the blank field stands for, and on a MIXED field writing
    // it is the whole point: it is what makes the selection agree.
    fireEvent.change(field(), { target: { value: '0' } });
    fireEvent.blur(field());
    expect(onChange.mock.calls).toEqual([[0]]);
  });

  it('stays blank when it is left alone', () => {
    const onChange = mount({ value: 0, mixed: true });
    fireEvent.focus(field());
    fireEvent.blur(field());
    expect(onChange).not.toHaveBeenCalled();
    expect(field().value).toBe('');
  });
});
