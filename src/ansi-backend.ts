/**
 * ANSI terminal backend for terminui.
 * Adapted from terminui examples/jsx-chatbot.tsx.
 */
import { stdout } from 'node:process';
import type { Cell } from 'terminui';
import { charWidth } from 'terminui';
import type { Position, Size, Backend } from 'terminui';
import { Modifier } from 'terminui';

type TerminalColor = Cell['fg'];

const namedColorAnsi = (type: string, bg: boolean): string => {
  const map: Record<string, number> = {
    black: 30, red: 31, green: 32, yellow: 33, blue: 34,
    magenta: 35, cyan: 36, gray: 37, 'dark-gray': 90,
    'light-red': 91, 'light-green': 92, 'light-yellow': 93,
    'light-blue': 94, 'light-magenta': 95, 'light-cyan': 96, white: 97,
  };
  const code = map[type];
  return code === undefined ? (bg ? '49' : '39') : String(bg ? code + 10 : code);
};

const colorAnsi = (color: TerminalColor | undefined, bg: boolean): string => {
  if (!color || color.type === 'reset') return bg ? '49' : '39';
  if (color.type === 'indexed') return `${bg ? '48' : '38'};5;${color.index}`;
  if (color.type === 'rgb') return `${bg ? '48' : '38'};2;${color.r};${color.g};${color.b}`;
  return namedColorAnsi(color.type, bg);
};

const modifierAnsi = (modifier: number): string[] => {
  const codes: string[] = [];
  if (Modifier.contains(modifier, Modifier.BOLD)) codes.push('1');
  if (Modifier.contains(modifier, Modifier.DIM)) codes.push('2');
  if (Modifier.contains(modifier, Modifier.ITALIC)) codes.push('3');
  if (Modifier.contains(modifier, Modifier.UNDERLINED)) codes.push('4');
  if (Modifier.contains(modifier, Modifier.REVERSED)) codes.push('7');
  return codes;
};

const styleKey = (cell: Cell): string => {
  const fgAny = cell.fg as unknown as Record<string,unknown> | undefined;
  const bgAny = cell.bg as unknown as Record<string,unknown> | undefined;
  const fg = cell.fg ? `${cell.fg.type}:${fgAny?.index ?? fgAny?.r ?? ''}` : 'u';
  const bg = cell.bg ? `${cell.bg.type}:${bgAny?.index ?? bgAny?.r ?? ''}` : 'u';
  return `${fg}|${bg}|${cell.modifier}`;
};

const styleAnsi = (cell: Cell): string => {
  const codes = [colorAnsi(cell.fg, false), colorAnsi(cell.bg, true), ...modifierAnsi(cell.modifier)];
  return `\u001B[0;${codes.join(';')}m`;
};

export function createAnsiBackend(): Backend {
  let pending = '';
  let style = '';
  let cursor: Position = { x: 0, y: 0 };

  return {
    size: (): Size => ({
      width: Math.max(70, stdout.columns ?? 90),
      height: Math.max(18, (stdout.rows ?? 28) - 1),
    }),
    draw: (content): void => {
      if (content.length === 0) return;
      const sorted = [...content].sort((a, b) => (a.y - b.y) || (a.x - b.x));
      for (const entry of sorted) {
        if (cursor.y !== entry.y || cursor.x !== entry.x) {
          pending += `\u001B[${entry.y + 1};${entry.x + 1}H`;
          cursor = { x: entry.x, y: entry.y };
        }
        const key = styleKey(entry.cell);
        if (key !== style) {
          pending += styleAnsi(entry.cell);
          style = key;
        }
        const sym = entry.cell.symbol === '' ? ' ' : entry.cell.symbol;
        pending += sym;
        cursor = { x: cursor.x + Math.max(1, charWidth(sym.codePointAt(0) ?? 0)), y: cursor.y };
      }
    },
    flush: (): void => {
      if (pending.length === 0) return;
      stdout.write(pending);
      pending = '';
    },
    hideCursor: (): void => { stdout.write('\u001B[?25l'); },
    showCursor: (): void => { stdout.write('\u001B[?25h'); },
    getCursorPosition: (): Position => cursor,
    setCursorPosition: (pos: Position): void => {
      cursor = pos;
      stdout.write(`\u001B[${pos.y + 1};${pos.x + 1}H`);
    },
    clear: (): void => {
      stdout.write('\u001B[2J\u001B[H');
      style = '';
      cursor = { x: 0, y: 0 };
    },
  };
}
