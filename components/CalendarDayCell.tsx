import React, { memo, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { scale, verticalScale, moderateScale } from 'react-native-size-matters';
import type { CalendarDayCellModel } from '../utils/calendarDayCellState';

type ThemeColors = {
  text: string;
  buttonBackground: string;
  buttonText: string;
  textSecondary: string;
  primary: string;
};

function CalendarDayCellInner({
  day,
  model,
  theme,
  onPress,
}: {
  day: number;
  model: CalendarDayCellModel;
  theme: ThemeColors;
  onPress: () => void;
}) {
  const { workoutState, isToday, isCurrentMonth } = model;

  const numberColor = useMemo(() => {
    if (!isCurrentMonth) return theme.text;
    if (workoutState === 'logged') return theme.buttonText;
    return theme.text;
  }, [isCurrentMonth, workoutState, theme]);

  const innerBg = useMemo(() => {
    switch (workoutState) {
      case 'logged':
        return { backgroundColor: theme.buttonBackground };
      case 'missed':
        return {
          backgroundColor: 'rgba(232, 160, 120, 0.14)',
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderColor: 'rgba(245, 240, 232, 0.22)',
        };
      case 'scheduled':
        return { backgroundColor: 'rgba(124, 154, 126, 0.22)' };
      default:
        return {};
    }
  }, [workoutState, theme.buttonBackground]);

  const todayHalo =
    isToday && workoutState === 'empty'
      ? {
          backgroundColor: 'rgba(124, 154, 126, 0.28)',
          borderWidth: 3,
          borderColor: theme.buttonBackground,
        }
      : isToday
        ? {
            borderWidth: 3,
            borderColor: theme.buttonBackground,
          }
        : {};

  const marker = useMemo(() => {
    if (workoutState === 'logged') {
      return (
        <Ionicons
          name="checkmark"
          size={scale(15)}
          color={theme.buttonText}
          style={styles.markerIcon}
        />
      );
    }
    if (workoutState === 'missed') {
      return (
        <Ionicons
          name="close"
          size={scale(13)}
          color="rgba(180, 180, 180, 0.95)"
          style={styles.markerIcon}
        />
      );
    }
    if (workoutState === 'scheduled') {
      return (
        <View
          style={[
            styles.scheduledBar,
            { backgroundColor: theme.buttonBackground },
          ]}
        />
      );
    }
    if (isToday) {
      return <View style={styles.todayDot} />;
    }
    return <View style={styles.markerSpacer} />;
  }, [workoutState, isToday, theme]);

  return (
    <TouchableOpacity
      style={styles.gridCell}
      onPress={onPress}
      activeOpacity={0.72}
      accessibilityRole="button"
      accessibilityLabel={`Day ${day}`}
    >
      <View style={styles.column}>
        <View style={[styles.numberShell, todayHalo]}>
          <View style={[styles.numberInner, innerBg]}>
            <Text
              style={[
                styles.dayText,
                {
                  color: numberColor,
                  opacity: isCurrentMonth ? 1 : 0.32,
                },
              ]}
            >
              {day}
            </Text>
          </View>
        </View>
        <View style={styles.markerRow}>{marker}</View>
      </View>
    </TouchableOpacity>
  );
}

export const CalendarDayCell = memo(CalendarDayCellInner);

const styles = StyleSheet.create({
  gridCell: {
    width: `${100 / 7}%`,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: verticalScale(1),
  },
  column: {
    alignItems: 'center',
    width: '100%',
  },
  numberShell: {
    borderRadius: scale(20),
    padding: scale(2),
    justifyContent: 'center',
    alignItems: 'center',
  },
  numberInner: {
    minWidth: scale(36),
    minHeight: scale(36),
    borderRadius: scale(18),
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: scale(4),
  },
  dayText: {
    fontSize: moderateScale(16),
    fontWeight: '600',
  },
  markerRow: {
    height: verticalScale(14),
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: verticalScale(2),
  },
  markerIcon: {
    marginTop: verticalScale(-1),
  },
  scheduledBar: {
    width: scale(22),
    height: verticalScale(4),
    borderRadius: 2,
    marginTop: verticalScale(1),
  },
  todayDot: {
    width: scale(5),
    height: scale(5),
    borderRadius: scale(3),
    backgroundColor: 'rgba(124, 154, 126, 0.9)',
    marginTop: verticalScale(2),
  },
  markerSpacer: {
    height: verticalScale(4),
  },
});
