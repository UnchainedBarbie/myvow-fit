/**
 * Full-screen onboarding: 8 slides, button-only navigation, AsyncStorage on complete.
 */
import React, { useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
  Dimensions,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Ellipse, Path, Rect } from 'react-native-svg';

const BG = '#F5F0E8';
const PRIMARY = '#7C9A7E';
const SLIDE_COUNT = 8;

const GOAL_OPTIONS = [
  'Lose Weight',
  'Build Muscle',
  'Maintain',
  'Improve Health',
  'Improve Performance',
] as const;

const DIET_OPTIONS = ['None', 'Vegan', 'Vegetarian', 'Keto', 'Paleo', 'Gluten-Free'] as const;

export type OnboardingProps = {
  onComplete: () => void;
};

const { width: SCREEN_WIDTH } = Dimensions.get('window');

function IllustrationWelcome() {
  return (
    <Svg width={160} height={160} viewBox="0 0 160 160">
      <Circle cx={80} cy={80} r={56} fill={PRIMARY} opacity={0.25} />
      <Circle cx={80} cy={80} r={40} fill={PRIMARY} opacity={0.45} />
      <Path
        d="M80 48 L88 72 L112 72 L92 86 L100 110 L80 96 L60 110 L68 86 L48 72 L72 72 Z"
        fill={PRIMARY}
      />
    </Svg>
  );
}

function IllustrationDumbbell() {
  return (
    <Svg width={180} height={120} viewBox="0 0 180 120">
      <Rect x={24} y={44} width={28} height={32} rx={4} fill={PRIMARY} />
      <Rect x={128} y={44} width={28} height={32} rx={4} fill={PRIMARY} />
      <Rect x={48} y={54} width={84} height={12} rx={3} fill={PRIMARY} opacity={0.85} />
    </Svg>
  );
}

function IllustrationPlate() {
  return (
    <Svg width={160} height={140} viewBox="0 0 160 140">
      <Ellipse cx={80} cy={72} rx={64} ry={36} fill={PRIMARY} opacity={0.2} />
      <Ellipse cx={80} cy={68} rx={52} ry={28} fill={PRIMARY} opacity={0.35} />
      <Circle cx={64} cy={64} r={10} fill={PRIMARY} opacity={0.6} />
      <Circle cx={88} cy={70} r={8} fill={PRIMARY} opacity={0.6} />
      <Rect x={118} y={40} width={4} height={48} rx={1} fill={PRIMARY} opacity={0.5} />
      <Rect x={124} y={52} width={14} height={4} rx={1} fill={PRIMARY} opacity={0.5} />
    </Svg>
  );
}

function IllustrationChat() {
  return (
    <Svg width={180} height={140} viewBox="0 0 180 140">
      <Path
        d="M24 28 H140 Q152 28 152 40 V72 Q152 84 140 84 H56 L36 104 V84 H28 Q16 84 16 72 V40 Q16 28 28 28 Z"
        fill={PRIMARY}
        opacity={0.35}
      />
      <Path
        d="M48 52 H152 Q164 52 164 64 V96 Q164 108 152 108 H88 L68 124 V108 H56 Q44 108 44 96 V64 Q44 52 56 52 Z"
        fill={PRIMARY}
        opacity={0.55}
      />
    </Svg>
  );
}

export default function Onboarding({ onComplete }: OnboardingProps) {
  const listRef = useRef<FlatList<number>>(null);
  const [index, setIndex] = useState(0);

  const [name, setName] = useState('');
  const [age, setAge] = useState('');
  const [gender, setGender] = useState<string | null>(null);
  const [weightLbs, setWeightLbs] = useState('');
  const [heightFt, setHeightFt] = useState('');
  const [heightIn, setHeightIn] = useState('');
  const [goals, setGoals] = useState<Set<string>>(new Set());
  const [diet, setDiet] = useState<string>('None');
  const [allergies, setAllergies] = useState('');
  const [brands, setBrands] = useState('');

  const scrollTo = useCallback((i: number) => {
    const clamped = Math.max(0, Math.min(SLIDE_COUNT - 1, i));
    listRef.current?.scrollToOffset({ offset: clamped * SCREEN_WIDTH, animated: true });
    setIndex(clamped);
  }, []);

  const goNext = useCallback(() => {
    if (index === 4) {
      if (!name.trim()) {
        Alert.alert('Name required', 'Please enter your name to continue.');
        return;
      }
    }
    if (index < SLIDE_COUNT - 1) {
      scrollTo(index + 1);
    }
  }, [index, name, scrollTo]);

  const goBack = useCallback(() => {
    if (index > 0) scrollTo(index - 1);
  }, [index, scrollTo]);

  const skipIntro = useCallback(() => {
    scrollTo(4);
  }, [scrollTo]);

  const toggleGoal = useCallback((g: string) => {
    setGoals((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  }, []);

  const finish = useCallback(async () => {
    try {
      const ft = parseInt(heightFt, 10);
      const inch = parseInt(heightIn, 10);
      const heightPayload = JSON.stringify({
        ft: Number.isFinite(ft) ? ft : 0,
        in: Number.isFinite(inch) ? inch : 0,
      });
      await AsyncStorage.multiSet([
        ['@user_name', name.trim()],
        ['@user_age', age.trim()],
        ['@user_gender', gender ?? ''],
        ['@user_weight', weightLbs.trim()],
        ['@user_height', heightPayload],
        ['@user_goals', JSON.stringify([...goals])],
        ['@sage_diet', diet],
        ['@sage_allergies', allergies.trim()],
        ['@sage_brands', brands.trim()],
        ['@onboarding_profile_saved', 'true'],
      ]);
      onComplete();
    } catch (e) {
      console.error('Onboarding save error:', e);
      Alert.alert('Error', 'Could not save your preferences. Please try again.');
    }
  }, [name, age, gender, weightLbs, heightFt, heightIn, goals, diet, allergies, brands, onComplete]);

  const renderSlide = (i: number) => {
    switch (i) {
      case 0:
        return (
          <View style={styles.slideInner}>
            <IllustrationWelcome />
            <Text style={styles.title}>MyVow Fit</Text>
            <Text style={styles.body}>Your coach. Your plan. Your vow.</Text>
          </View>
        );
      case 1:
        return (
          <View style={styles.slideInner}>
            <IllustrationDumbbell />
            <Text style={styles.title}>Workouts</Text>
            <Text style={styles.body}>Build workouts or let Sage design one for you</Text>
          </View>
        );
      case 2:
        return (
          <View style={styles.slideInner}>
            <IllustrationPlate />
            <Text style={styles.title}>Nutrition</Text>
            <Text style={styles.body}>Track meals, scan barcodes, and hit your macros</Text>
          </View>
        );
      case 3:
        return (
          <View style={styles.slideInner}>
            <IllustrationChat />
            <Text style={styles.title}>Sage AI Coach</Text>
            <Text style={styles.body}>
              Chat with Sage to create workout and meal plans tailored to you
            </Text>
          </View>
        );
      case 4:
        return (
          <ScrollView
            style={styles.formScroll}
            contentContainerStyle={styles.formScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.title}>Your Profile</Text>
            <Text style={styles.label}>Name</Text>
            <TextInput
              style={styles.input}
              placeholder="Your name"
              placeholderTextColor="#999"
              value={name}
              onChangeText={setName}
              autoCapitalize="words"
            />
            <Text style={styles.label}>Age</Text>
            <TextInput
              style={styles.input}
              placeholder="Age"
              placeholderTextColor="#999"
              value={age}
              onChangeText={setAge}
              keyboardType="number-pad"
            />
            <Text style={styles.label}>Gender</Text>
            <View style={styles.chipRow}>
              {(['Male', 'Female', 'Other'] as const).map((g) => (
                <TouchableOpacity
                  key={g}
                  style={[styles.chip, gender === g && styles.chipActive]}
                  onPress={() => setGender(g)}
                >
                  <Text style={[styles.chipText, gender === g && styles.chipTextActive]}>{g}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
        );
      case 5:
        return (
          <ScrollView
            style={styles.formScroll}
            contentContainerStyle={styles.formScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.title}>Your Body</Text>
            <Text style={styles.label}>Weight (lbs)</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. 165"
              placeholderTextColor="#999"
              value={weightLbs}
              onChangeText={setWeightLbs}
              keyboardType="decimal-pad"
            />
            <Text style={styles.label}>Height</Text>
            <View style={styles.heightRow}>
              <View style={styles.heightField}>
                <Text style={styles.sublabel}>Feet</Text>
                <TextInput
                  style={styles.input}
                  placeholder="5"
                  placeholderTextColor="#999"
                  value={heightFt}
                  onChangeText={setHeightFt}
                  keyboardType="number-pad"
                />
              </View>
              <View style={styles.heightField}>
                <Text style={styles.sublabel}>Inches</Text>
                <TextInput
                  style={styles.input}
                  placeholder="10"
                  placeholderTextColor="#999"
                  value={heightIn}
                  onChangeText={setHeightIn}
                  keyboardType="number-pad"
                />
              </View>
            </View>
          </ScrollView>
        );
      case 6:
        return (
          <ScrollView
            style={styles.formScroll}
            contentContainerStyle={styles.formScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.title}>Your Goals</Text>
            <Text style={styles.bodyMuted}>Select all that apply</Text>
            <View style={styles.chipWrap}>
              {GOAL_OPTIONS.map((g) => (
                <TouchableOpacity
                  key={g}
                  style={[styles.chip, goals.has(g) && styles.chipActive]}
                  onPress={() => toggleGoal(g)}
                >
                  <Text style={[styles.chipText, goals.has(g) && styles.chipTextActive]}>{g}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
        );
      case 7:
        return (
          <ScrollView
            style={styles.formScroll}
            contentContainerStyle={styles.formScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.title}>Sage Preferences</Text>
            <Text style={styles.label}>Diet type</Text>
            <View style={styles.chipWrap}>
              {DIET_OPTIONS.map((d) => (
                <TouchableOpacity
                  key={d}
                  style={[styles.chip, diet === d && styles.chipActive]}
                  onPress={() => setDiet(d)}
                >
                  <Text style={[styles.chipText, diet === d && styles.chipTextActive]}>{d}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.label}>Allergies</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="e.g. peanuts, shellfish"
              placeholderTextColor="#999"
              value={allergies}
              onChangeText={setAllergies}
              multiline
            />
            <Text style={styles.label}>Preferred brands</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Optional"
              placeholderTextColor="#999"
              value={brands}
              onChangeText={setBrands}
              multiline
            />
          </ScrollView>
        );
      default:
        return null;
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.topBar}>
          <View style={styles.topBarFlex} />
          {index < 4 ? (
            <TouchableOpacity onPress={skipIntro} style={styles.skipBtn} hitSlop={12}>
              <Text style={styles.skipText}>Skip</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.skipPlaceholder} />
          )}
        </View>

        <FlatList
          ref={listRef}
          style={styles.list}
          data={Array.from({ length: SLIDE_COUNT }, (_, n) => n)}
          horizontal
          pagingEnabled
          scrollEnabled={false}
          showsHorizontalScrollIndicator={false}
          keyExtractor={(item) => String(item)}
          getItemLayout={(_, i) => ({
            length: SCREEN_WIDTH,
            offset: SCREEN_WIDTH * i,
            index: i,
          })}
          renderItem={({ item: slideIndex }) => (
            <View style={[styles.slide, { width: SCREEN_WIDTH }]}>{renderSlide(slideIndex)}</View>
          )}
          onMomentumScrollEnd={(e) => {
            const x = e.nativeEvent.contentOffset.x;
            const i = Math.round(x / SCREEN_WIDTH);
            setIndex(i);
          }}
        />

        <View style={styles.dots}>
          {Array.from({ length: SLIDE_COUNT }, (_, d) => (
            <View
              key={d}
              style={[styles.dot, d === index && styles.dotActive]}
            />
          ))}
        </View>

        <View style={styles.navRow}>
          <TouchableOpacity
            style={[styles.navBtn, styles.navBtnSecondary, index === 0 && styles.navBtnDisabled]}
            onPress={goBack}
            disabled={index === 0}
          >
            <Text style={[styles.navBtnTextSecondary, index === 0 && styles.navBtnTextDisabled]}>
              Back
            </Text>
          </TouchableOpacity>
          {index === SLIDE_COUNT - 1 ? (
            <TouchableOpacity style={[styles.navBtn, styles.navBtnPrimary]} onPress={finish}>
              <Text style={styles.navBtnTextPrimary}>Get Started</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={[styles.navBtn, styles.navBtnPrimary]} onPress={goNext}>
              <Text style={styles.navBtnTextPrimary}>Next</Text>
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  flex: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 20,
    paddingVertical: 8,
    minHeight: 44,
  },
  topBarFlex: { flex: 1 },
  skipPlaceholder: { minWidth: 56 },
  list: { flex: 1 },
  skipBtn: { paddingVertical: 8, paddingHorizontal: 4 },
  skipText: {
    fontFamily: 'Jost_400Regular',
    fontSize: 16,
    color: PRIMARY,
    fontWeight: '600',
  },
  slide: {
    flex: 1,
    justifyContent: 'center',
  },
  slideInner: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingBottom: 24,
  },
  formScroll: { flex: 1 },
  formScrollContent: {
    paddingHorizontal: 28,
    paddingBottom: 24,
    paddingTop: 8,
  },
  title: {
    fontFamily: 'CormorantGaramond-Bold',
    fontSize: 32,
    color: '#2C2C2C',
    textAlign: 'center',
    marginBottom: 12,
    marginTop: 8,
  },
  body: {
    fontFamily: 'Jost_400Regular',
    fontSize: 18,
    color: '#444',
    textAlign: 'center',
    lineHeight: 26,
    paddingHorizontal: 8,
  },
  bodyMuted: {
    fontFamily: 'Jost_400Regular',
    fontSize: 15,
    color: '#666',
    marginBottom: 16,
    textAlign: 'center',
  },
  label: {
    fontFamily: 'Jost_400Regular',
    fontSize: 15,
    color: '#333',
    marginBottom: 8,
    marginTop: 12,
  },
  sublabel: {
    fontFamily: 'Jost_400Regular',
    fontSize: 13,
    color: '#666',
    marginBottom: 6,
  },
  input: {
    fontFamily: 'Jost_400Regular',
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#D4CFC4',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#fff',
    color: '#222',
  },
  textArea: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 4,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 8,
  },
  chip: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 24,
    borderWidth: 1.5,
    borderColor: '#C5C0B6',
    backgroundColor: '#fff',
  },
  chipActive: {
    borderColor: PRIMARY,
    backgroundColor: PRIMARY,
  },
  chipText: {
    fontFamily: 'Jost_400Regular',
    fontSize: 15,
    color: '#444',
  },
  chipTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
  heightRow: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 4,
  },
  heightField: { flex: 1 },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 16,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#C5C0B6',
  },
  dotActive: {
    backgroundColor: PRIMARY,
    width: 22,
    borderRadius: 4,
  },
  navRow: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingBottom: 20,
    gap: 12,
  },
  navBtn: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navBtnPrimary: {
    backgroundColor: PRIMARY,
  },
  navBtnSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: PRIMARY,
  },
  navBtnDisabled: {
    opacity: 0.35,
    borderColor: '#C5C0B6',
  },
  navBtnTextPrimary: {
    fontFamily: 'Jost_400Regular',
    fontSize: 17,
    fontWeight: '700',
    color: '#fff',
  },
  navBtnTextSecondary: {
    fontFamily: 'Jost_400Regular',
    fontSize: 17,
    fontWeight: '600',
    color: PRIMARY,
  },
  navBtnTextDisabled: {
    color: '#999',
  },
});
