// Phase 5A design tokens — dark-first, one accent color, generous spacing.
// Every screen/component reads colors via ThemeContext, so the mode switch is
// instant app-wide. Keep raw values here only; never hardcode colors in screens.
export const palettes = {
  dark: {
    mode: 'dark',
    bg: '#0B0F17',
    bgAlt: '#141B28',
    card: '#111827',
    cardAlt: '#0E1522',
    border: '#1F2937',
    borderStrong: '#334155',
    text: '#E8EEF9',
    textDim: '#93A1B8',
    textFaint: '#5D6B82',
    accent: '#3D8BFF',
    accentSoft: 'rgba(61, 139, 255, 0.16)',
    onAccent: '#FFFFFF',
    danger: '#F4525F',
    dangerSoft: 'rgba(244, 82, 95, 0.16)',
    success: '#34D399',
    successSoft: 'rgba(52, 211, 153, 0.14)',
    warning: '#F5A524',
    warningSoft: 'rgba(245, 165, 36, 0.16)',
    info: '#38BDF8',
    infoSoft: 'rgba(56, 189, 248, 0.14)',
  },
  light: {
    mode: 'light',
    bg: '#F4F6FB',
    bgAlt: '#E9EEF6',
    card: '#FFFFFF',
    cardAlt: '#F8FAFD',
    border: '#DCE3EE',
    borderStrong: '#C3CDDE',
    text: '#0F1728',
    textDim: '#51607A',
    textFaint: '#8B98AE',
    accent: '#2563EB',
    accentSoft: 'rgba(37, 99, 235, 0.10)',
    onAccent: '#FFFFFF',
    danger: '#DC2626',
    dangerSoft: 'rgba(220, 38, 38, 0.10)',
    success: '#16A34A',
    successSoft: 'rgba(22, 163, 74, 0.12)',
    warning: '#B45309',
    warningSoft: 'rgba(180, 83, 9, 0.12)',
    info: '#0284C7',
    infoSoft: 'rgba(2, 132, 199, 0.12)',
  },
};

export const radius = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 22, xxl: 30 };
