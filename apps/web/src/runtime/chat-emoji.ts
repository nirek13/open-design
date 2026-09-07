export const CHAT_EMOJI_GROUPS: ReadonlyArray<{ label: string; emoji: string[] }> = [
  { label: 'Smileys', emoji: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '😉', '😍', '😘', '😜', '🤔', '🤨', '😐', '😴', '🥳', '😎', '🤩', '😭', '😡'] },
  { label: 'Gestures', emoji: ['👍', '👎', '👏', '🙌', '🙏', '👌', '✌️', '🤞', '👋', '💪', '👀', '❤️', '🔥', '🎉', '✨', '⭐', '💯', '✅', '❌', '⚠️'] },
  { label: 'Work', emoji: ['📌', '📎', '📝', '📊', '💡', '🗓️', '⏰', '✅', '🚀', '🎯', '💬', '📣', '🗂️', '📦', '🔗', '💻'] },
  { label: 'Food', emoji: ['🍕', '🍔', '🌮', '🍣', '🍩', '🍪', '🍰', '☕', '🍵', '🍺'] },
];

export const QUICK_REACTIONS = ['👍', '🎉', '❤️', '👀', '😄'] as const;
