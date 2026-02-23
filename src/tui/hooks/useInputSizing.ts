const BORDER = 2;
const HEADER_HEIGHT = 3;
const MIN_MESSAGES_VISIBLE = 3;
const MIN_INPUT_HEIGHT = 6;

export interface InputSizing {
  inputHeight: number;
  textareaHeight: number;
}

/**
 * Calculate input area height based on terminal height and line count.
 * The input grows with content but is capped so header + a few message rows remain visible.
 */
export function calcInputSizing(termHeight: number, inputLineCount: number): InputSizing {
  const maxInputHeight = Math.max(MIN_INPUT_HEIGHT, termHeight - HEADER_HEIGHT - MIN_MESSAGES_VISIBLE);
  const inputHeight = Math.min(Math.max(inputLineCount + BORDER, MIN_INPUT_HEIGHT), maxInputHeight);
  const textareaHeight = inputHeight - BORDER;
  return { inputHeight, textareaHeight };
}
