import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { WorkoutStackParamList } from '../App';
import { Workout } from '../utils/types';
import React from 'react';
import { TouchableOpacity, Text, StyleSheet, View, FlatList } from 'react-native';
import { Swipeable, RectButton } from 'react-native-gesture-handler';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useTheme } from '../context/ThemeContext'; // Adjust the path to your ThemeContext
import { useTranslation } from 'react-i18next';
import { useSQLiteContext } from 'expo-sqlite';
import { exportWorkout } from '../utils/workoutSharingUtils';

type WorkoutListNavigationProp = StackNavigationProp<
  WorkoutStackParamList,
  'WorkoutsList'
>;

export default function WorkoutList({
  workouts,
  deleteWorkout,
  getWorkouts: _getWorkouts,
}: {
  workouts: Workout[];
  deleteWorkout: (workout_id: number, workout_name: string) => Promise<void>;
  getWorkouts: () => Promise<void>;
}) {
  const navigation = useNavigation<WorkoutListNavigationProp>();
  const { theme } = useTheme(); // Get the current theme
  const { t } = useTranslation(); // Initialize translations
  const db = useSQLiteContext();
  const sortedWorkouts = [...workouts].sort(
    (a, b) => b.workout_id - a.workout_id,
  );

  const handleExportWorkout = (workoutId: number) => {
    exportWorkout(db, workoutId);
  };

  const listHeader = (
    <View style={styles.actionButtonsContainer}>
      <TouchableOpacity
        style={[styles.buildActionButton, { backgroundColor: theme.primary || '#7C9A7E' }]}
        activeOpacity={0.7}
        onPress={() => (navigation.getParent?.() ?? navigation).navigate('Sage' as never)}
      >
        <Text style={styles.buildActionButtonTextLight}>
          {t('buildWithSage') || 'Build with Sage ✦'}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.buildActionButton, { backgroundColor: theme.buttonBackground }]}
        activeOpacity={0.7}
        onPress={() => navigation.navigate('CreateWorkout')}
      >
        <Text style={[styles.buildActionButtonTextDark, { color: theme.buttonText }]}>
          {t('buildMyself') || 'Build it myself'}
        </Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <FlatList
      data={sortedWorkouts}
      keyExtractor={(item) => item.workout_id.toString()}
      style={[styles.list, { backgroundColor: theme.background }]}
      contentContainerStyle={styles.contentContainer}
      ListHeaderComponent={listHeader}
      keyboardShouldPersistTaps="handled"
      renderItem={({ item: workout }) => {
        let swipeRef: Swipeable | null = null;
        const renderRightActions = () => (
          <RectButton
            style={[styles.deleteButton, { backgroundColor: '#c62828' }]}
            onPress={() => {
              swipeRef?.close();
              void deleteWorkout(workout.workout_id, workout.workout_name);
            }}
          >
            <Text style={styles.swipeBtnText}>{t('delete') || 'Delete'}</Text>
          </RectButton>
        );
        return (
          <Swipeable
            ref={(r) => {
              swipeRef = r;
            }}
            renderRightActions={renderRightActions}
            friction={2}
            overshootLeft={false}
            overshootRight={false}
          >
            <TouchableOpacity
              style={[
                styles.workoutCard,
                {
                  backgroundColor: theme.card,
                  borderColor: theme.border,
                },
              ]}
              activeOpacity={0.7}
              onPress={() =>
                navigation.navigate('WorkoutDetails', {
                  workout_id: workout.workout_id,
                })
              }
              onLongPress={() =>
                void deleteWorkout(workout.workout_id, workout.workout_name)
              }
              delayLongPress={450}
              accessibilityHint={t('deleteWorkoutLongPressHint')}
            >
              <View style={styles.workoutNameWrapper}>
                <Text style={[styles.workoutText, { color: theme.text }]} numberOfLines={1} ellipsizeMode="tail">
                  {workout.workout_name}
                </Text>
                <TouchableOpacity
                  onPress={(e) => {
                    e?.stopPropagation?.();
                    (navigation.getParent?.() ?? navigation).navigate('My Calendar', {
                      preselectedWorkoutId: workout.workout_id,
                      preselectedWorkoutName: workout.workout_name,
                    });
                  }}
                  style={styles.scheduleButton}
                >
                  <Text style={[styles.scheduleButtonText, { color: theme.primary || '#7C9A7E' }]}>Add to Schedule</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => handleExportWorkout(workout.workout_id)}
                >
                  <Ionicons
                    name="share-outline"
                    size={24}
                    color={theme.text}
                    style={styles.shareIcon}
                  />
                </TouchableOpacity>
              </View>
              <Ionicons name="chevron-forward" size={20} color={theme.text} />
            </TouchableOpacity>
          </Swipeable>
        );
      }}
    />
  );
}

//WorkoutList.tsx

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  contentContainer: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 32,
  },
  actionButtonsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 20,
  },
  buildActionButton: {
    flex: 1,
    flexBasis: 0,
    borderRadius: 50,
    paddingVertical: 15,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 5,
    elevation: 2,
  },
  buildActionButtonTextLight: {
    fontSize: 18,
    fontFamily: 'Jost_500Medium',
    color: '#fff',
  },
  buildActionButtonTextDark: {
    fontSize: 18,
    fontFamily: 'Jost_500Medium',
  },

  workoutCard: {
    backgroundColor: '#F7F7F7',
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.1)',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.8,
    shadowRadius: 5,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  workoutText: {
    fontSize: 20,
    fontFamily: 'Jost_400Regular',
    flex: 1,
    minWidth: 0,
  },
  workoutNameWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
    gap: 8,
  },
  scheduleButton: { paddingVertical: 4, paddingHorizontal: 8 },
  scheduleButtonText: { fontSize: 13, fontWeight: '600' },
  shareIcon: {
    marginLeft: 10,
  },
  deleteButton: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 80,
    borderRadius: 10,
    marginBottom: 16,
  },
  swipeBtnText: {
    color: '#fff',
    fontSize: 16,
    fontFamily: 'Jost_500Medium',
  },
});
