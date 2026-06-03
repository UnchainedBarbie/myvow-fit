  // App.tsx
  import React, { useState, useEffect, useRef, useCallback } from 'react';
  import { View, ActivityIndicator, StatusBar, StyleSheet, Text, Platform, TouchableOpacity } from 'react-native'; // Import Platform
import * as FileSystem from 'expo-file-system/legacy';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { Asset } from 'expo-asset';
  import { createStackNavigator } from '@react-navigation/stack';
  import { NavigationContainer } from '@react-navigation/native';
  import Ionicons from 'react-native-vector-icons/Ionicons';
  import Home from './screens/Home'; // Assuming you have a Home screen component
  import Workouts from './screens/Workouts';
  import CreateWorkout from './screens/CreateWorkout';
  import { GestureHandlerRootView } from 'react-native-gesture-handler';
  import { createNativeStackNavigator } from '@react-navigation/native-stack';
  import WorkoutDetails from './screens/WorkoutDetails';
  import MyCalendar from './screens/MyCalendar';
  import LogWorkout from './screens/LogWorkout';
  import MyProgress from './screens/MyProgress';
  import LogWeights from './screens/LogWeights';
  import WeightLogDetail from './screens/WeightLogDetail';
  import RecurringWorkoutOptions from './screens/RecurringWorkoutOptions';
  import CreateRecurringWorkout from './screens/CreateRecurringWorkout';
  import ManageRecurringWorkouts from './screens/ManageRecurringWorkouts';
  import RecurringWorkoutDetails from './screens/RecurringWorkoutDetails';
  import EditRecurringWorkout from './screens/EditRecurringWorkout';
  import StartedWorkoutInterface from './screens/StartedWorkoutInterface';
  import './utils/i18n'; // Ensure this is present to initialize i18n
  import i18n from './utils/i18n'; // Import the i18n instance
  import { I18nextProvider } from 'react-i18next';
  import Settings from './screens/Settings';
import Sage from './screens/Sage';
import Nutrition from './screens/Nutrition';
  import MealPlanDetail from './screens/MealPlanDetail';
  import MyVow from './screens/MyVow';
  import { SettingsProvider, useSettings } from './context/SettingsContext';
  import { ThemeProvider, useTheme } from './context/ThemeContext';
  import { ProfileProvider } from './context/ProfileContext';
  import { DrawerMenuProvider } from './context/DrawerMenuContext';
  import AppDrawer from './components/AppDrawer';
  import { rootNavigationRef } from './utils/rootNavigationRef';
  import EditWorkout from './screens/EditWorkout';
  import AllLogs from './screens/AllLogs';
  import BodyWeightLogs from './screens/BodyWeightLogs';
  import Difficulty from './screens/Difficulty';
  import Template from './screens/Template';
  import TemplateDetails from './screens/TemplateDetails';
import * as Notifications from 'expo-notifications';
  import { useRecurringWorkouts } from './utils/recurringWorkoutUtils';
  import { checkAndSyncPermissions } from './utils/notificationUtils';
  import { AppState } from 'react-native';
import GraphsWorkoutDetails from './screens/GraphsWorkoutDetails';
import { initNutritionDb, migrateLoggedFoodsAddLogIdColumnSafe } from './utils/nutritionDb';
import { initMealPlansDb } from './utils/initMealPlansDb';
import { initPurchasedProductsDb } from './utils/purchasedProducts';
import { addRecurringTable, createUpdateTriggers } from './utils/addRecurringTable';
import { initWorkoutDb } from './utils/initWorkoutDb';
import * as SplashScreen from 'expo-splash-screen';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Onboarding from './screens/Onboarding';
import Paywall from './screens/Paywall';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  getSubscriptionState,
  setSubscriptionState,
} from './utils/settingsStorage';
import type { IapPurchase } from './services/iap';

/** Bump to a new name (e.g. SimpleDB.v2.db) to force a fresh schema on next load; init runs on open. */
const SQLITE_DATABASE_NAME = 'SimpleDB.db';

/** Run once after DB open to keep important tables/indexes in sync. */
async function onSqliteInit(db: { runAsync: (sql: string) => Promise<void> }) {
  // Do NOT drop DayActivePlan here — that wiped every user's active plan/day assignments on each
  // app launch. Ensure tables via idempotent CREATE IF NOT EXISTS only.
  await initMealPlansDb(db as any);
  await initPurchasedProductsDb(db as any);
  await migrateLoggedFoodsAddLogIdColumnSafe(db as any);

  // Allow INSERT OR REPLACE on Workout_Log for duplicate (workout_date, day_name, workout_name)
  await db.runAsync(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_workout_log_uniq ON Workout_Log(workout_date, day_name, workout_name);'
  );

  // Ensure Recurring_Workouts table and its triggers exist so recurring utils don't crash.
  // These helpers are idempotent (CREATE TABLE/CREATE TRIGGER IF NOT EXISTS).
  await addRecurringTable(db as any);
  await createUpdateTriggers(db as any);
  await initWorkoutDb(db as any);
}
import { useFonts } from 'expo-font';
import {
  Jost_300Light,
  Jost_400Regular,
  Jost_500Medium,
  Jost_600SemiBold,
} from '@expo-google-fonts/jost';

  const Stack = createStackNavigator();
  const NutritionStackScreen = createNativeStackNavigator();
  const WorkoutStackScreen = createNativeStackNavigator<WorkoutStackParamList>();
  const WorkoutLogStackScreen= createNativeStackNavigator<WorkoutLogStackParamList>();
  const WeightLogStackScreen= createNativeStackNavigator<WeightLogStackParamList>();
  const StartWorkoutStackScreen = createNativeStackNavigator<StartWorkoutStackParamList>();

  



  

  const resetDatabase = async () => {
    try {
      const dbName = "SimpleDB.db";
      const dbFilePath = `${FileSystem.documentDirectory}SQLite/${dbName}`;


      // Check if the database file exists
      const fileInfo = await FileSystem.getInfoAsync(dbFilePath);
      if (fileInfo.exists) {
        // Delete the existing database file
        console.log("Deleting existing database...");
        await FileSystem.deleteAsync(dbFilePath, { idempotent: true });
        console.log("Database deleted.");
      }

      // Recreate the database folder if necessary
      await FileSystem.makeDirectoryAsync(
        `${FileSystem.documentDirectory}SQLite`,
        { intermediates: true }
      );

      // Initialize a new database (or download a fresh copy)
      const dbAsset = require("./assets/SimpleDB.db");
      const dbUri = Asset.fromModule(dbAsset).uri;

      console.log("Downloading new database...");
      await FileSystem.downloadAsync(dbUri, dbFilePath);
      console.log("New database downloaded.");
    } catch (error) {
      console.error("Error resetting database:", error);
    }
  };



  const loadDatabase = async () => {
    try {
      const dbName = "SimpleDB.db";
      const dbAsset = require("./assets/SimpleDB.db");
      const dbUri = Asset.fromModule(dbAsset).uri;
      const dbFilePath = `${FileSystem.documentDirectory}SQLite/${dbName}`;

      const fileInfo = await FileSystem.getInfoAsync(dbFilePath);
      if (!fileInfo.exists) {
        await FileSystem.makeDirectoryAsync(
          `${FileSystem.documentDirectory}SQLite`,
          { intermediates: true }
        );
        console.log("Copying database...");
        await FileSystem.downloadAsync(dbUri, dbFilePath);
        console.log("Database ready.");
      } else {
        console.log("Database already exists.");
      }
    } catch (error) {
      console.error("Error in loadDatabase:", error);
    }
  };


  


  export type WorkoutStackParamList = {
    WorkoutsList: undefined; // No parameters for this route
    CreateWorkout: undefined; // No parameters for this route
    WorkoutDetails: { workout_id: number }; // Add this
    EditWorkout: { workout_id: number }; // Only `workout_id` for editing a workout
    TemplateList: undefined;
    DifficultyList: undefined;
    Difficulty: undefined;
    Template: { workout_difficulty: string };
    TemplateDetails: { workout_id: number };
  };

  export type WorkoutLogStackParamList = {
    MyCalendar: { refresh?: boolean; preselectedWorkoutId?: number; preselectedWorkoutName?: string };
    LogWorkout: { selectedDate?: string };
    RecurringWorkoutOptions: undefined;
    CreateRecurringWorkout: undefined;
    ManageRecurringWorkouts: undefined;
    RecurringWorkoutDetails: { recurring_workout_id: number };
    EditRecurringWorkout: { recurring_workout_id: number };
    StartedWorkoutInterface: { workout_log_id: number; resume?: boolean };
    LogWeights: { workout_log_id?: number };
  };

  export type WeightLogStackParamList = {
    MyProgress: undefined;
    LogWeights: { workout_log_id?: number };
    WeightLogDetail:{ workoutName: string }
    AllLogs: undefined;
    GraphsWorkoutDetails: undefined;
  }

  export type StartWorkoutStackParamList = {
    StartWorkout: { fromNotification?: boolean } | undefined;
    StartedWorkoutInterface: { workout_log_id: number; resume?: boolean };
  }

  function WorkoutStack() {
    return (

      <SQLiteProvider databaseName={SQLITE_DATABASE_NAME} useSuspense onInit={onSqliteInit}>

      <WorkoutStackScreen.Navigator screenOptions={{
        headerShown: false, // Disable headers for all screens in this stack
      }}
    >
        <WorkoutStackScreen.Screen
          name="WorkoutsList"
          component={Workouts}
          options={{ headerShown: false }}
        />
        <WorkoutStackScreen.Screen
          name="CreateWorkout"
          component={CreateWorkout}
          options={{ title: 'Create Workout' }}
        />
        <WorkoutStackScreen.Screen
          name='WorkoutDetails'
          component={WorkoutDetails}
          options={{title: 'WorkoutDetails'}}
          />
             <WorkoutStackScreen.Screen
          name='EditWorkout'
          component={EditWorkout}
          options={{title: 'EditWorkout'}}
          />
                       <WorkoutStackScreen.Screen
          name='Difficulty'
          component={Difficulty}
          options={{title: 'Difficulty'}}
          />
                       <WorkoutStackScreen.Screen
          name='Template'
          component={Template}
          options={{title: 'Template'}}
          />
                       <WorkoutStackScreen.Screen
          name='TemplateDetails'
          component={TemplateDetails}
          options={{title: 'TemplateDetails'}}
          />
      </WorkoutStackScreen.Navigator>
      </SQLiteProvider>
    );
  }

  function WorkoutLogStack() {
    return (
      <WorkoutLogStackScreen.Navigator
        screenOptions={{
          headerShown: false, // Disable headers for all screens in this stack
        }}
      >
        <WorkoutLogStackScreen.Screen
          name="MyCalendar"
          component={MyCalendar}
          options={{ headerShown: false }} // No header for MyCalendar screen
        />
        <WorkoutLogStackScreen.Screen
          name="LogWorkout"
          component={LogWorkout}
          options={{ title: 'Log a Workout' }} // Title for the LogWorkout screen
        />
        <WorkoutLogStackScreen.Screen
          name="RecurringWorkoutOptions"
          component={RecurringWorkoutOptions}
          options={{ title: 'Recurring Workout Options' }}
        /> 
         <WorkoutLogStackScreen.Screen
          name="CreateRecurringWorkout"
          component={CreateRecurringWorkout}
          options={{ title: 'Create Recurring Workout' }}
        /> 
        <WorkoutLogStackScreen.Screen
          name="ManageRecurringWorkouts"
          component={ManageRecurringWorkouts}
          options={{ title: 'Manage Recurring Workouts' }}
        /> 
         <WorkoutLogStackScreen.Screen
          name="RecurringWorkoutDetails"
          component={RecurringWorkoutDetails}
          options={{ title: 'Recurring Workout Details' }}
        /> 
        <WorkoutLogStackScreen.Screen
          name="EditRecurringWorkout"
          component={EditRecurringWorkout}
          options={{ title: 'Edit Recurring Workout' }}
        />
        <WorkoutLogStackScreen.Screen
          name="StartedWorkoutInterface"
          component={StartedWorkoutInterface}
          options={{ headerShown: false }}
        />
        <WorkoutLogStackScreen.Screen
          name="LogWeights"
          component={LogWeights}
          options={{ headerShown: false }}
        />
      </WorkoutLogStackScreen.Navigator>

      
    );
  }


  function NutritionStack() {
    return (
      <NutritionStackScreen.Navigator screenOptions={{ headerShown: false }}>
        <NutritionStackScreen.Screen name="Nutrition" component={Nutrition} />
        <NutritionStackScreen.Screen name="MealPlanDetail" component={MealPlanDetail} />
      </NutritionStackScreen.Navigator>
    );
  }

  function WeightLogStack() {
    return (
      <WeightLogStackScreen.Navigator
        initialRouteName="MyProgress"
        screenOptions={{
          headerShown: false, // Disable headers for all screens in this stack
        }}
      >
        <WeightLogStackScreen.Screen
          name="MyProgress"
          component={MyProgress}
          options={{ headerShown: false }}
        />
        <WeightLogStackScreen.Screen
          name="GraphsWorkoutDetails"
          component={GraphsWorkoutDetails}
          options={{ headerShown: false }}
        />
        <WeightLogStackScreen.Screen
          name="LogWeights"
          component={LogWeights}
          options={{ title: 'Log Weights' }} // Title for the LogWorkout screen
        />

  <WeightLogStackScreen.Screen
          name="WeightLogDetail"
          component={WeightLogDetail}
          options={{ headerShown: false }} // No header for MyCalendar screen
        />
      <WeightLogStackScreen.Screen
          name="AllLogs"
          component={AllLogs}
          options={{ headerShown: false }} // No header for MyCalendar screen
        />
        <WeightLogStackScreen.Screen
          name="BodyWeightLogs"
          component={BodyWeightLogs}
          options={{ headerShown: false }}
        />
      </WeightLogStackScreen.Navigator>
    );
  }

  /*function StartWorkoutStack() {
    return (
      <StartWorkoutStackScreen.Navigator
        screenOptions={{
          headerShown: false, // Disable headers for all screens in this stack
        }}
      >
        <StartWorkoutStackScreen.Screen
          name="StartWorkout"
          component={StartWorkout}
          options={{ headerShown: false }}
        />
        <StartWorkoutStackScreen.Screen
          name="StartedWorkoutInterface"
          component={StartedWorkoutInterface}
          options={{ headerShown: false }}
        />
      </StartWorkoutStackScreen.Navigator>
    );
  }*/

// First, create a component that will handle the recurring workout checks
SplashScreen.preventAutoHideAsync().catch(() => {});

function RecurringWorkoutManager() {
  const { checkRecurringWorkouts } = useRecurringWorkouts();
  const appState = useRef(AppState.currentState);
  const initialCheckDone = useRef(false);

  useEffect(() => {
    // Function to check workouts and publish event
    const checkAndNotify = async () => {
      if (!initialCheckDone.current) {
        await checkRecurringWorkouts();
        // Publish event to notify MyCalendar to refresh
        console.log('Initial recurring workout check triggered and event published');
        initialCheckDone.current = true;
      }
    };
    
    checkAndNotify();
    
    // Set up listener for app returning to foreground
   

  }, [checkRecurringWorkouts]);

  return null;
}

function NutritionDbInitializer() {
  const db = useSQLiteContext();

  useEffect(() => {
    initNutritionDb(db as any).catch((e) => {
      console.error('Error initializing nutrition DB tables:', e);
    });
  }, [db]);

  return null;
}

/** In-app route to Paywall (e.g. future Settings entry); CTA returns to Home. */
function PaywallScreen({ navigation }: { navigation: { navigate: (name: string) => void } }) {
  return (
    <Paywall
      onContinue={async () => {
        navigation.navigate('Home');
      }}
    />
  );
}

// Define AppContent here
const AppContent = ({ onOpenMainDrawer }: { onOpenMainDrawer: () => void }) => {
  const { theme } = useTheme();
  const { notificationPermissionGranted, setNotificationPermissionGranted } =
    useSettings();

  useEffect(() => {
    if (notificationPermissionGranted) {
      checkAndSyncPermissions(setNotificationPermissionGranted);
    }
  }, [notificationPermissionGranted, setNotificationPermissionGranted]);

  return (
    <>
      <StatusBar
        barStyle={theme.type === 'light' ? 'dark-content' : 'light-content'}
        backgroundColor={theme.background}
      />
      <React.Suspense
        fallback={
          <View style={{ flex: 1 }}>
            <ActivityIndicator size="large" />
          </View>
        }
      >
        <SQLiteProvider databaseName={SQLITE_DATABASE_NAME} useSuspense onInit={onSqliteInit}>
          <RecurringWorkoutManager />
          <NutritionDbInitializer />
          <DrawerMenuProvider onOpen={onOpenMainDrawer}>
          <>
          <Stack.Navigator
            screenOptions={{
              headerStyle: { backgroundColor: theme.background },
              headerTintColor: theme.text,
              headerTitleAlign: 'center',
              headerLeft: () => (
                <TouchableOpacity
                  onPress={onOpenMainDrawer}
                  style={{ paddingLeft: 16 }}
                  accessibilityLabel="Open menu"
                  hitSlop={{ top: 12, bottom: 12, right: 12, left: 8 }}
                >
                  <Ionicons name="menu-outline" size={28} color="#7C9A7E" />
                </TouchableOpacity>
              ),
            }}
          >
            <Stack.Screen
              name="Home"
              component={Home}
              options={{ headerShown: false }}
            />
            <Stack.Screen name="Sage" component={Sage} options={{ title: 'Sage' }} />
            <Stack.Screen
              name="My Workouts"
              component={WorkoutStack}
              options={{ headerTitle: 'My Workouts' }}
            />
            <Stack.Screen
              name="Nutrition"
              component={NutritionStack}
              options={{ headerTitle: 'Nutrition' }}
            />
            <Stack.Screen
              name="My Calendar"
              component={WorkoutLogStack}
              options={{ headerTitle: 'My Calendar' }}
            />
            <Stack.Screen
              name="My Progress"
              component={WeightLogStack}
              options={{ headerTitle: 'My Progress' }}
            />
            <Stack.Screen name="MyVow" component={MyVow} options={{ headerTitle: 'MyVow Fit' }} />
            <Stack.Screen name="Settings" component={Settings} options={{ headerTitle: 'Settings' }} />
            <Stack.Screen name="Paywall" component={PaywallScreen} options={{ headerShown: false }} />
          </Stack.Navigator>
          </>
          </DrawerMenuProvider>
        </SQLiteProvider>
      </React.Suspense>
    </>
  );
};

/** Drawer modal lives above NavigationContainer so it is not trapped under native-stack layers (e.g. MealPlanDetail). */
function NavigationWithDrawer() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const openMainDrawer = useCallback(() => setDrawerOpen(true), []);
  return (
    <ProfileProvider>
      <AppDrawer visible={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <NavigationContainer ref={rootNavigationRef}>
        <SettingsProvider>
          <I18nextProvider i18n={i18n}>
            <AppContent onOpenMainDrawer={openMainDrawer} />
          </I18nextProvider>
        </SettingsProvider>
      </NavigationContainer>
    </ProfileProvider>
  );
}

  export default function App() {
    const [dbLoaded, setDbLoaded] = useState(false);
    const [onboardingResolved, setOnboardingResolved] = useState(false);
    const [showOnboarding, setShowOnboarding] = useState(false);
    const [showPaywall, setShowPaywall] = useState(false);
    const [paywallError, setPaywallError] = useState<string | null>(null);
    const [fontsLoaded] = useFonts({
      'CormorantGaramond-Regular': require('./assets/fonts/CormorantGaramond-Regular.ttf'),
      'CormorantGaramond-Bold': require('./assets/fonts/CormorantGaramond-Bold.ttf'),
      'CormorantGaramond-Italic': require('./assets/fonts/CormorantGaramond-Italic.ttf'),
      'CormorantGaramond-SemiBold': require('./assets/fonts/CormorantGaramond-SemiBold.ttf'),
      Jost_300Light,
      Jost_400Regular,
      Jost_500Medium,
      Jost_600SemiBold,
    });

    /**
     * Initialize the IAP connection, wire success/error listeners (their delivery is
     * the canonical source of purchase outcome in v15), and check whether a previously
     * purchased subscription is still active for this Apple ID (e.g., reinstall case).
     * Listener handlers persist to userSettings.json and dismiss the paywall.
     */
    useEffect(() => {
      let cancelled = false;
      let teardown: (() => void) | null = null;
      (async () => {
        try {
          const iap = await import('./services/iap');
          await iap.initializeIAP();
          if (cancelled) return;

          iap.setupPurchaseListeners(
            (purchase: IapPurchase) => {
              const productId = purchase?.productId ?? null;
              const expirationMs =
                purchase?.expirationDateIOS != null
                  ? Number(purchase.expirationDateIOS)
                  : null;
              const expiresAtIso =
                expirationMs && Number.isFinite(expirationMs)
                  ? new Date(expirationMs).toISOString()
                  : null;
              setSubscriptionState({
                subscription_status: 'active',
                subscription_product_id: productId,
                subscription_expires_at: expiresAtIso,
              }).catch((e) =>
                console.warn('[IAP] persisting active subscription failed:', e),
              );
              AsyncStorage.setItem('@onboarding_complete', 'true').catch((e) =>
                console.warn('[IAP] marking onboarding complete failed:', e),
              );
              setPaywallError(null);
              setShowPaywall(false);
            },
            (error) => {
              const code = String(error?.code ?? '').toLowerCase();
              if (code.includes('cancel')) {
                // User backed out of the StoreKit sheet — quiet path.
                return;
              }
              const message =
                typeof error?.message === 'string' && error.message.length > 0
                  ? error.message
                  : 'Something went wrong with the purchase. Please try again.';
              setPaywallError(message);
            },
          );
          teardown = iap.teardownPurchaseListeners;

          const active = await iap.getActiveSubscription();
          if (cancelled) return;
          if (active.isActive && active.productId) {
            await setSubscriptionState({
              subscription_status: 'active',
              subscription_product_id: active.productId,
              subscription_expires_at: active.expiresAt
                ? active.expiresAt.toISOString()
                : null,
            });
          } else if (active.productId) {
            // Known product but expired — keep the productId for context.
            await setSubscriptionState({
              subscription_status: 'expired',
              subscription_product_id: active.productId,
              subscription_expires_at: active.expiresAt
                ? active.expiresAt.toISOString()
                : null,
            });
          }
        } catch (e) {
          console.error('[IAP] Launch initialization error:', e);
        }
      })();

      return () => {
        cancelled = true;
        if (teardown) {
          try {
            teardown();
          } catch (e) {
            console.warn('[IAP] teardownPurchaseListeners threw:', e);
          }
        }
      };
    }, []);

    useEffect(() => {
      loadDatabase().then(() => setDbLoaded(true));
      
      // Configure notification permissions
      const setupNotifications = async () => {
        // Don't request permissions on app start - this will be handled when needed
        await Notifications.setNotificationHandler({
          handleNotification: async () => ({
            shouldShowAlert: true,
            shouldPlaySound: true,
            shouldSetBadge: false,
          }),
        });
        
      };
      
      setupNotifications();
      
      return () => {
        // Clean up if needed
      };
    }, []);

    React.useEffect(() => {
      (async () => {
        try {
          // await resetDatabase();
          await loadDatabase();
          setDbLoaded(true);
        } catch (e) {
          console.error("Database loading error:", e);
        }
      })();
    }, []);

    useEffect(() => {
      if (!fontsLoaded) return;
      (async () => {
        try {
          // Active subscribers skip the paywall regardless of onboarding flags so a
          // reinstalled user with an existing entitlement lands in the app immediately.
          const sub = await getSubscriptionState();
          if (sub.subscription_status === 'active') {
            setShowOnboarding(false);
            setShowPaywall(false);
            return;
          }
          const done = await AsyncStorage.getItem('@onboarding_complete');
          const profileSaved = await AsyncStorage.getItem('@onboarding_profile_saved');
          if (done === 'true') {
            // Onboarded but not active → still gate behind the paywall.
            setShowOnboarding(false);
            setShowPaywall(true);
          } else if (profileSaved === 'true') {
            setShowOnboarding(false);
            setShowPaywall(true);
          } else {
            setShowOnboarding(true);
            setShowPaywall(false);
          }
        } catch (e) {
          console.warn('Onboarding check:', e);
          setShowOnboarding(true);
          setShowPaywall(false);
        } finally {
          setOnboardingResolved(true);
        }
      })();
    }, [fontsLoaded]);

    useEffect(() => {
      if (dbLoaded && fontsLoaded && onboardingResolved) {
        SplashScreen.hideAsync().catch(() => {});
      }
    }, [dbLoaded, fontsLoaded, onboardingResolved]);
  
    if (!dbLoaded || !fontsLoaded || !onboardingResolved) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color="black" />
        </View>
      );
    }


    return (
      <ThemeProvider>
      <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {showOnboarding ? (
          <Onboarding
            onComplete={() => {
              setShowOnboarding(false);
              setShowPaywall(true);
            }}
          />
        ) : showPaywall ? (
          <Paywall
            errorMessage={paywallError}
            onSubscriptionActivated={async () => {
              // Fired from a successful Restore. A direct-purchase success is handled
              // by the purchaseUpdatedListener; that path also dismisses the paywall.
              try {
                await AsyncStorage.setItem('@onboarding_complete', 'true');
              } catch (e) {
                console.warn('Paywall: could not persist onboarding complete:', e);
              }
              setPaywallError(null);
              setShowPaywall(false);
            }}
          />
        ) : (
        <NavigationWithDrawer />
        )}
      </GestureHandlerRootView>
      </SafeAreaProvider>
    </ThemeProvider>
    );
  }

  const styles = StyleSheet.create({
    permissionBanner: {
      backgroundColor: '#FFF9C4',
      padding: 12,
      borderBottomWidth: 1,
      borderBottomColor: '#E0E0E0',
    },
    permissionText: {
      fontSize: 14,
      color: '#333333',
      textAlign: 'center',
    },
  });