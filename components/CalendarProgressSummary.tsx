import React, { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { scale, verticalScale, moderateScale } from 'react-native-size-matters';
import type { CalendarInsights } from '../utils/calendarInsights';
import type { TFunction } from 'i18next';

type ThemeColors = {
  card: string;
  text: string;
  textSecondary: string;
  border: string;
  buttonBackground: string;
};

function formatNextWhen(
  d: Date,
  t: TFunction,
  dateFormat: 'mm-dd-yyyy' | 'dd-mm-yyyy',
): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round(
    (target.getTime() - today.getTime()) / (24 * 3600 * 1000),
  );
  if (diff === 0) return t('Today');
  if (diff === 1) return t('Tomorrow');
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return dateFormat === 'mm-dd-yyyy'
    ? `${month}/${day}`
    : `${day}/${month}`;
}

function CalendarProgressSummaryInner({
  insights,
  theme,
  t,
  dateFormat,
}: {
  insights: CalendarInsights;
  theme: ThemeColors;
  t: TFunction;
  dateFormat: 'mm-dd-yyyy' | 'dd-mm-yyyy';
}) {
  const { streakDays, weekCompleted, weekScheduled, nextWorkoutLabel, nextWorkoutDate } =
    insights;

  const streakPhrase =
    streakDays === 0
      ? t('calendarStreakStart', { defaultValue: 'Start a streak today' })
      : t('calendarStreakDays', {
          count: streakDays,
          defaultValue: '{{count}} day streak',
        });

  const weekPhrase =
    weekScheduled === 0
      ? t('calendarWeekRest', {
          defaultValue: 'No workouts scheduled this week',
        })
      : t('calendarWeekProgress', {
          done: weekCompleted,
          total: weekScheduled,
          defaultValue: '{{done}}/{{total}} workouts this week',
          done: weekCompleted,
          total: weekScheduled,
        });

  let nextPhrase: string;
  if (nextWorkoutLabel && nextWorkoutDate) {
    const when = formatNextWhen(nextWorkoutDate, t, dateFormat);
    nextPhrase = t('calendarNextLine', {
      name: nextWorkoutLabel,
      when,
      defaultValue: 'Next: {{name}} · {{when}}',
      name: nextWorkoutLabel,
      when,
    });
  } else {
    nextPhrase = t('calendarNextNone', {
      defaultValue: "You're clear — schedule your next session",
    });
  }

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.card,
          borderColor: theme.border,
        },
      ]}
    >
      <Text style={[styles.kicker, { color: theme.textSecondary }]}>
        {t('calendarProgressKicker', { defaultValue: 'Your momentum' })}
      </Text>
      <View style={styles.row}>
        <Ionicons
          name="flame"
          size={scale(22)}
          color={theme.buttonBackground}
          style={styles.rowIcon}
        />
        <Text style={[styles.primaryLine, { color: theme.text }]}>
          {streakPhrase}
        </Text>
      </View>
      <View style={styles.row}>
        <Ionicons
          name="bar-chart-outline"
          size={scale(20)}
          color={theme.textSecondary}
          style={styles.rowIcon}
        />
        <Text style={[styles.secondaryLine, { color: theme.text }]}>
          {weekPhrase}
        </Text>
      </View>
      <View style={styles.row}>
        <Ionicons
          name="arrow-forward-circle-outline"
          size={scale(20)}
          color={theme.textSecondary}
          style={styles.rowIcon}
        />
        <Text style={[styles.secondaryLine, { color: theme.text }]}>
          {nextPhrase}
        </Text>
      </View>
    </View>
  );
}

export const CalendarProgressSummary = memo(CalendarProgressSummaryInner);

const styles = StyleSheet.create({
  card: {
    width: '100%',
    maxWidth: 400,
    alignSelf: 'center',
    borderRadius: 16,
    borderWidth: 1,
    paddingVertical: verticalScale(14),
    paddingHorizontal: scale(16),
    marginTop: verticalScale(10),
  },
  kicker: {
    fontSize: moderateScale(12),
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: verticalScale(10),
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: verticalScale(8),
  },
  rowIcon: {
    marginRight: scale(10),
    width: scale(26),
  },
  primaryLine: {
    flex: 1,
    fontSize: moderateScale(17),
    fontWeight: '700',
  },
  secondaryLine: {
    flex: 1,
    fontSize: moderateScale(15),
    fontWeight: '500',
    opacity: 0.95,
  },
});
