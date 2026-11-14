const LABELS: Record<string, string> = { '👍': 'Thumbs up', '❤️': 'Heart', '😂': 'Laugh', '😮': 'Surprised', '😢': 'Sad', '🙏': 'Thanks' }
export const reactionLabel = (emoji: string) => LABELS[emoji] ?? emoji
