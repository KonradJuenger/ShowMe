import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export function IconChevronLeft(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M10 13L5 8L10 3" />
    </svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 6L8 10L12 6" />
    </svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M6 4L10 8L6 12" />
    </svg>
  );
}

export function IconChevronsUpDown(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 6L8 3L11 6" />
      <path d="M5 10L8 13L11 10" />
    </svg>
  );
}

export function IconSlideNavigator(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M6 2.5V13.5" />
    </svg>
  );
}

export function IconInspectorSidebar(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M10 2.5V13.5" />
    </svg>
  );
}

export function IconMore(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" {...props}>
      <circle cx="3.5" cy="8" r="1.15" />
      <circle cx="8" cy="8" r="1.15" />
      <circle cx="12.5" cy="8" r="1.15" />
    </svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M8 3V13" />
      <path d="M3 8H13" />
    </svg>
  );
}

export function IconPlay(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" {...props}>
      <path d="M4.5 2.8C4.5 2.1 5.3 1.7 5.9 2.1L13.1 6.8C13.6 7.2 13.6 8 13.1 8.4L5.9 13.1C5.3 13.5 4.5 13.1 4.5 12.4V2.8Z" />
    </svg>
  );
}

export function IconText(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 4H13" />
      <path d="M8 4V13" />
      <path d="M6 13H10" />
    </svg>
  );
}

export function IconShape(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="3" width="10" height="10" rx="2" />
    </svg>
  );
}

export function IconMedia(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <circle cx="5.5" cy="6" r="1.2" fill="currentColor" />
      <path d="M14 10.5L10.5 7L4.5 13.5" />
    </svg>
  );
}

export function IconFrame(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 2V14" />
      <path d="M11 2V14" />
      <path d="M2 5H14" />
      <path d="M2 11H14" />
    </svg>
  );
}

export function IconFormat(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12.5 2.5L13.5 3.5C14.2 4.2 14.2 5.3 13.5 6L6.5 13H3V9.5L10 2.5C10.7 1.8 11.8 1.8 12.5 2.5Z" />
      <path d="M9 3.5L12.5 7" />
    </svg>
  );
}

export function IconUndo(props: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 6H10C12.2 6 14 7.8 14 10C14 12.2 12.2 14 10 14H6" />
      <path d="M6 3L3 6L6 9" />
    </svg>
  );
}

export function IconRedo(props: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M13 6H6C3.8 6 2 7.8 2 10C2 12.2 3.8 14 6 14H10" />
      <path d="M10 3L13 6L10 9" />
    </svg>
  );
}

export function IconSnapping(props: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M9 2L3.5 9H8L7 14L12.5 7H8L9 2Z" />
    </svg>
  );
}

export function IconRulers(props: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="2" y="4" width="12" height="8" rx="1.5" />
      <path d="M5 4V7" />
      <path d="M8 4V6" />
      <path d="M11 4V7" />
    </svg>
  );
}

export function IconGuides(props: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 2V14" strokeDasharray="2 2" />
      <path d="M12 2V14" strokeDasharray="2 2" />
      <path d="M2 8H14" />
    </svg>
  );
}

export function IconSnapToGuides(props: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M13 2V14" />
      <path d="M3 8H10" />
      <path d="M7 5L10 8L7 11" />
    </svg>
  );
}

export function IconGrid(props: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  );
}

export function IconBold(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 3H9.5C11 3 12 4 12 5.5C12 7 11 8 9.5 8H4V3Z" />
      <path d="M4 8H10.5C12 8 13 9 13 10.5C13 12 12 13 10.5 13H4V8Z" />
    </svg>
  );
}

export function IconItalic(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="9" y1="3" x2="13" y2="3" />
      <line x1="3" y1="13" x2="7" y2="13" />
      <line x1="11" y1="3" x2="5" y2="13" />
    </svg>
  );
}

export function IconUnderline(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 3V7.5C4 9.7 5.8 11.5 8 11.5C10.2 11.5 12 9.7 12 7.5V3" />
      <line x1="3" y1="14" x2="13" y2="14" />
    </svg>
  );
}

export function IconStrikethrough(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 4.5C11.5 3.5 10 3 8 3C5.5 3 4.5 4.5 4.5 5.5C4.5 8 11.5 7.5 11.5 10.5C11.5 12 10 13 8 13C5.8 13 4.5 11.8 4 11" />
      <line x1="2" y1="8" x2="14" y2="8" strokeWidth="2" />
    </svg>
  );
}

export function IconAlignLeft(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" {...props}>
      <line x1="2" y1="3.5" x2="14" y2="3.5" />
      <line x1="2" y1="7.5" x2="9.5" y2="7.5" />
      <line x1="2" y1="11.5" x2="12" y2="11.5" />
    </svg>
  );
}

export function IconAlignCenter(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" {...props}>
      <line x1="2" y1="3.5" x2="14" y2="3.5" />
      <line x1="4.5" y1="7.5" x2="11.5" y2="7.5" />
      <line x1="3" y1="11.5" x2="13" y2="11.5" />
    </svg>
  );
}

export function IconAlignRight(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" {...props}>
      <line x1="2" y1="3.5" x2="14" y2="3.5" />
      <line x1="6.5" y1="7.5" x2="14" y2="7.5" />
      <line x1="4" y1="11.5" x2="14" y2="11.5" />
    </svg>
  );
}

export function IconAlignJustify(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" {...props}>
      <line x1="2" y1="3.5" x2="14" y2="3.5" />
      <line x1="2" y1="7.5" x2="14" y2="7.5" />
      <line x1="2" y1="11.5" x2="14" y2="11.5" />
    </svg>
  );
}

export function IconAlignTop(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="2" y1="2.5" x2="14" y2="2.5" />
      <rect x="4.5" y="5.5" width="7" height="8" rx="1" />
    </svg>
  );
}

export function IconAlignMiddle(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="2" y1="8" x2="14" y2="8" strokeDasharray="1.5 1.5" />
      <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
    </svg>
  );
}

export function IconAlignBottom(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="2" y1="13.5" x2="14" y2="13.5" />
      <rect x="4.5" y="2.5" width="7" height="8" rx="1" />
    </svg>
  );
}

export function IconLayerBack(props: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polygon points="8,1.5 14,4.5 8,7.5 2,4.5" />
      <path d="M2 8L8 11L14 8" />
      <path d="M2 11.5L8 14.5L14 11.5" />
    </svg>
  );
}

export function IconLayerFront(props: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polygon points="8,1.5 14,4.5 8,7.5 2,4.5" fill="currentColor" fillOpacity="0.18" />
      <path d="M2 8L8 11L14 8" />
      <path d="M2 11.5L8 14.5L14 11.5" />
    </svg>
  );
}

export function IconLayerBackward(props: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="4 6 8 10 12 6" />
    </svg>
  );
}

export function IconLayerForward(props: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="12 10 8 6 4 10" />
    </svg>
  );
}

export function IconPopout(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M10 2H14V6" />
      <path d="M6.5 9.5L14 2" />
      <path d="M13 9V13.5C13 13.8 12.8 14 12.5 14H2.5C2.2 14 2 13.8 2 13.5V3.5C2 3.2 2.2 3 2.5 3H7" />
    </svg>
  );
}

export function IconFlipH(props: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="8" y1="2" x2="8" y2="14" strokeDasharray="2 2" />
      <polygon points="6,4 2,8 6,12" />
      <polygon points="10,4 14,8 10,12" />
    </svg>
  );
}

export function IconFlipV(props: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="2" y1="8" x2="14" y2="8" strokeDasharray="2 2" />
      <polygon points="4,6 8,2 12,6" />
      <polygon points="4,10 8,14 12,10" />
    </svg>
  );
}

export function IconLock(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V4.5C5.5 3.1 6.6 2 8 2C9.4 2 10.5 3.1 10.5 4.5V7" />
      <circle cx="8" cy="10.5" r="0.8" fill="currentColor" />
    </svg>
  );
}

export function IconUnlock(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V4.5C5.5 3.1 6.6 2 8 2C9.4 2 10.5 3.1 10.5 4" />
    </svg>
  );
}

export function IconEye(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M1.5 8C2.8 4.8 5.2 3 8 3C10.8 3 13.2 4.8 14.5 8C13.2 11.2 10.8 13 8 13C5.2 13 2.8 11.2 1.5 8Z" />
      <circle cx="8" cy="8" r="2.5" />
    </svg>
  );
}

export function IconEyeOff(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M1.5 1.5L14.5 14.5" />
      <path d="M6.5 6.7C6.2 7.1 6 7.5 6 8C6 9.1 6.9 10 8 10C8.5 10 8.9 9.8 9.3 9.5" />
      <path d="M3.7 4.2C2.7 5.2 1.9 6.5 1.5 8C2.8 11.2 5.2 13 8 13C9.7 13 11.3 12.3 12.5 11.2" />
      <path d="M6.2 3.3C6.8 3.1 7.4 3 8 3C10.8 3 13.2 4.8 14.5 8C14.0 9.2 13.3 10.2 12.4 11" />
    </svg>
  );
}


export function IconFolder(props: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M2 4.5h4l1.4 1.5H14v6.5c0 .8-.7 1.5-1.5 1.5h-9C2.7 14 2 13.3 2 12.5v-8Z" />
      <path d="M2 6h12" />
    </svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" {...props}>
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  );
}
