import { View, Text, Pressable, TextInput, ActivityIndicator, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { radius, space } from '../theme';

// Phase 5A reusable building blocks (Card, Chip, Button, StatusDot, ...).
// Dark-first: every component pulls its colors from ThemeContext. Keep the
// primitives dumb — no business logic here.

export function Screen({ children, pad = true, centered = false, scroll = false, edges = ['top', 'bottom'], style }) {
  const { palette } = useTheme();
  const outer = [{ flex: 1, backgroundColor: palette.bg }, style];
  const inner = scroll ? (
    <ScrollView
      style={{ flex: 1 }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[
        { gap: space.md },
        pad && { padding: space.lg },
        centered && { flexGrow: 1, justifyContent: 'center' },
      ]}
    >
      {children}
    </ScrollView>
  ) : (
    <View
      style={[
        { flex: 1, gap: space.md },
        pad && { padding: space.lg },
        centered && { justifyContent: 'center' },
      ]}
    >
      {children}
    </View>
  );
  return (
    <SafeAreaView style={outer} edges={edges}>
      {inner}
    </SafeAreaView>
  );
}

export function Card({ children, style, tone }) {
  const { palette } = useTheme();
  const border =
    tone === 'danger'
      ? palette.danger
      : tone === 'warning'
        ? palette.warning
        : tone === 'success'
          ? palette.success
          : palette.border;
  return (
    <View
      style={[
        {
          backgroundColor: palette.card,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: border,
          padding: space.lg,
          gap: space.sm,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionTitle({ children, style }) {
  const { palette } = useTheme();
  return (
    <Text
      style={[
        {
          color: palette.textDim,
          fontSize: 12,
          fontWeight: '700',
          letterSpacing: 1,
          textTransform: 'uppercase',
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export function StatusDot({ tone = 'neutral', size = 8 }) {
  const { palette } = useTheme();
  const colors = {
    ok: palette.success,
    warn: palette.warning,
    bad: palette.danger,
    info: palette.info,
    accent: palette.accent,
    neutral: palette.textFaint,
  };
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors[tone] ?? palette.textFaint,
      }}
    />
  );
}

export function Chip({ label, tone = 'neutral', dot = false, style }) {
  const { palette } = useTheme();
  const tones = {
    neutral: { bg: palette.bgAlt, fg: palette.textDim, bd: palette.border },
    accent: { bg: palette.accentSoft, fg: palette.accent, bd: 'transparent' },
    ok: { bg: palette.successSoft, fg: palette.success, bd: 'transparent' },
    warn: { bg: palette.warningSoft, fg: palette.warning, bd: 'transparent' },
    bad: { bg: palette.dangerSoft, fg: palette.danger, bd: 'transparent' },
    info: { bg: palette.infoSoft, fg: palette.info, bd: 'transparent' },
  };
  const t = tones[tone] ?? tones.neutral;
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          backgroundColor: t.bg,
          borderWidth: 1,
          borderColor: t.bd,
          borderRadius: radius.pill,
          paddingHorizontal: 10,
          paddingVertical: 4,
          alignSelf: 'flex-start',
        },
        style,
      ]}
    >
      {dot ? <StatusDot tone={tone} size={7} /> : null}
      <Text style={{ color: t.fg, fontSize: 12, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

export function Button({ title, onPress, tone = 'primary', busy = false, disabled = false, compact = false, style }) {
  const { palette } = useTheme();
  const tones = {
    primary: { bg: palette.accent, fg: palette.onAccent, bd: 'transparent' },
    secondary: { bg: 'transparent', fg: palette.text, bd: palette.borderStrong },
    danger: { bg: palette.danger, fg: '#FFFFFF', bd: 'transparent' },
    dangerGhost: { bg: 'transparent', fg: palette.danger, bd: palette.danger },
    ghost: { bg: 'transparent', fg: palette.accent, bd: 'transparent' },
  };
  const t = tones[tone] ?? tones.primary;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      android_ripple={{ color: 'rgba(255,255,255,0.15)' }}
      style={({ pressed }) => [
        {
          overflow: 'hidden',
          borderWidth: 1,
          borderRadius: compact ? radius.sm : radius.md,
          paddingVertical: compact ? 8 : 13,
          paddingHorizontal: compact ? 12 : 16,
          minHeight: compact ? 36 : 48,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: t.bg,
          borderColor: t.bd,
          opacity: disabled || busy ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={t.fg} size="small" />
      ) : (
        <Text numberOfLines={1} style={{ color: t.fg, fontWeight: '700', fontSize: compact ? 13 : 15 }}>
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function TextField({ label, style, ...props }) {
  const { palette } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      {label ? (
        <Text
          style={{
            color: palette.textDim,
            fontSize: 12,
            fontWeight: '700',
            letterSpacing: 0.8,
            textTransform: 'uppercase',
          }}
        >
          {label}
        </Text>
      ) : null}
      <TextInput
        placeholderTextColor={palette.textFaint}
        style={[
          {
            backgroundColor: palette.cardAlt,
            borderWidth: 1,
            borderColor: palette.border,
            borderRadius: radius.md,
            paddingHorizontal: 14,
            paddingVertical: 12,
            color: palette.text,
            fontSize: 15,
          },
          style,
        ]}
        {...props}
      />
    </View>
  );
}

export function EmptyState({ icon = '📭', title, hint }) {
  const { palette } = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: 6, paddingVertical: 28, paddingHorizontal: 16 }}>
      <Text style={{ fontSize: 34 }}>{icon}</Text>
      <Text style={{ color: palette.text, fontWeight: '700', fontSize: 15 }}>{title}</Text>
      {hint ? (
        <Text style={{ color: palette.textDim, fontSize: 13, textAlign: 'center', lineHeight: 19 }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
