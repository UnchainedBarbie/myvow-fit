import React from 'react';
import { View, Text, TouchableOpacity, Dimensions } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { ScaledSheet, scale } from 'react-native-size-matters'; // Import ScaledSheet for scaling
import { useTranslation } from 'react-i18next';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import HeaderAvatar from '../components/HeaderAvatar';





const { height } = Dimensions.get('window'); // Get screen height for dynamic sizing

export default function Home() {
  const { theme } = useTheme(); // Get the current theme
  const { t } = useTranslation(); // Initialize translations
  const navigation = useNavigation<any>();

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.headerContainer}>
        <Text style={styles.title}>
          <Text style={[styles.titleRegular, { color: theme.text }]}>MyVow </Text>
          <Text style={[styles.titleAccent, { color: theme.primary }]}>Fit</Text>
        </Text>
        <View style={styles.avatarPosition}>
          <HeaderAvatar />
        </View>
      </View>

      <View style={styles.grid}>
        <TouchableOpacity
          style={[
            styles.tile,
            {
              backgroundColor: theme.card,
              borderColor: theme.border,
            },
          ]}
          onPress={() => navigation.navigate('Sage')}
        >
          <Text style={[styles.tileIcon, { color: theme.primary }]}>✦</Text>
          <View style={styles.tileTextBlock}>
            <Text style={[styles.tileTitle, { color: theme.text }]}>
              MySage Chat
            </Text>
            <Text
              style={[
                styles.tileSubtitle,
                { color: theme.textSecondary || '#9A9A9A' },
              ]}
            >
              Your coach
            </Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.tile,
            {
              backgroundColor: theme.card,
              borderColor: theme.border,
            },
          ]}
          onPress={() => navigation.navigate('MyVow')}
        >
          <Ionicons
            name="infinite-outline"
            size={scale(22)}
            color={theme.primary}
            style={{ marginBottom: scale(8) }}
          />
          <View style={styles.tileTextBlock}>
            <Text style={[styles.tileTitle, { color: theme.text }]}>
              MyVow
            </Text>
            <Text
              style={[
                styles.tileSubtitle,
                { color: theme.textSecondary || '#9A9A9A' },
              ]}
            >
              Your commitments
            </Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.tile,
            {
              backgroundColor: theme.card,
              borderColor: theme.border,
            },
          ]}
          onPress={() => navigation.navigate('My Workouts')}
        >
          <Text style={[styles.tileIcon, { color: theme.primary }]}>⊕</Text>
          <View style={styles.tileTextBlock}>
            <Text style={[styles.tileTitle, { color: theme.text }]}>
              MyWorkouts
            </Text>
            <Text
              style={[
                styles.tileSubtitle,
                { color: theme.textSecondary || '#9A9A9A' },
              ]}
            >
              Browse & log
            </Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.tile,
            {
              backgroundColor: theme.card,
              borderColor: theme.border,
            },
          ]}
          onPress={() => navigation.navigate('Nutrition')}
        >
          <Text style={[styles.tileIcon, { color: theme.primary }]}>◎</Text>
          <View style={styles.tileTextBlock}>
            <Text style={[styles.tileTitle, { color: theme.text }]}>
              MyNutrition
            </Text>
            <Text
              style={[
                styles.tileSubtitle,
                { color: theme.textSecondary || '#9A9A9A' },
              ]}
            >
              Meals & macros
            </Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.tile,
            {
              backgroundColor: theme.card,
              borderColor: theme.border,
            },
          ]}
          onPress={() => navigation.navigate('My Progress')}
        >
          <Text style={[styles.tileIcon, { color: theme.primary }]}>↗</Text>
          <View style={styles.tileTextBlock}>
            <Text style={[styles.tileTitle, { color: theme.text }]}>
              MyProgress
            </Text>
            <Text
              style={[
                styles.tileSubtitle,
                { color: theme.textSecondary || '#9A9A9A' },
              ]}
            >
              Track & reflect
            </Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.tile,
            {
              backgroundColor: theme.card,
              borderColor: theme.border,
            },
          ]}
          onPress={() => navigation.navigate('My Calendar')}
        >
          <Text style={[styles.tileIcon, { color: theme.primary }]}>✚</Text>
          <View style={styles.tileTextBlock}>
            <Text style={[styles.tileTitle, { color: theme.text }]}>
              MyCalendar
            </Text>
            <Text
              style={[
                styles.tileSubtitle,
                { color: theme.textSecondary || '#9A9A9A' },
              ]}
            >
              Schedule & log
            </Text>
          </View>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// Home.tsx

const styles = ScaledSheet.create({
  container: {
    flex: 1,
    paddingTop: 60,
  },
  headerContainer: {
    position: 'relative',
    marginBottom: '15@vs', // Slightly reduced scaled margin
    alignItems: 'center',
    paddingTop: 16,
  },
  title: {
    fontSize: '36@s',
    textAlign: 'center',
  },
  titleRegular: {
    fontFamily: 'CormorantGaramond-Regular',
    fontStyle: 'normal',
    // Use theme text color via inline style in component; keep a neutral default here
    color: '#2C2C2C',
  },
  titleAccent: {
    fontFamily: 'CormorantGaramond-Italic',
    fontStyle: 'italic',
  },
  avatarPosition: {
    position: 'absolute',
    right: '16@s',
    top: '2@vs',
  },
  grid: {
    flex: 1,
    paddingHorizontal: '16@s',
    paddingTop: '8@vs',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  tile: {
    width: '48%',
    aspectRatio: 0.9,
    borderRadius: 16,
    borderWidth: 1,
    borderLeftWidth: 3,
    borderLeftColor: '#7C9A7E',
    padding: '10@s',
    marginBottom: '16@vs',
    justifyContent: 'space-between',
  },
  tileIcon: {
    fontSize: '18@s',
    marginBottom: '8@vs',
  },
  tileTextBlock: {
    marginTop: 'auto',
  },
  tileTitle: {
    fontSize: '18@s',
    fontFamily: 'Jost_500Medium',
  },
  tileSubtitle: {
    fontSize: '12@s',
    fontFamily: 'Jost_300Light',
    marginTop: '2@vs',
  },
});