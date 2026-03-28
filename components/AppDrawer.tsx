import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  TouchableOpacity,
  Animated,
  Dimensions,
  Platform,
  ScrollView,
  Image,
} from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { rootNavigationRef } from '../utils/rootNavigationRef';
import { useProfile } from '../context/ProfileContext';

/** Drawer panel background (sage tint). */
const DRAWER_SAGE_BG = '#A8BEA8';
const BRANDING_CREAM = '#F5F0E8';
/** Nav rows: Sage, MyVow, Workouts, Nutrition, Calendar, Progress */
const NAV_ITEM_BLACK = '#000000';
/** Dark green for drawer title (matches former Sage accent) */
const DRAWER_DARK_GREEN = '#4A6B4A';
/** Header / drawer avatar ring (matches HeaderAvatar) */
const AVATAR_SAGE = '#7C9A7E';

const DRAWER_WIDTH = Math.min(300, Dimensions.get('window').width * 0.85);

type NavItem = {
  label: string;
  routeName: string;
};

const NAV_ITEMS: NavItem[] = [
  { label: 'Sage', routeName: 'Sage' },
  { label: 'MyVow', routeName: 'MyVow' },
  { label: 'Workouts', routeName: 'My Workouts' },
  { label: 'Nutrition', routeName: 'Nutrition' },
  { label: 'Calendar', routeName: 'My Calendar' },
  { label: 'Progress', routeName: 'My Progress' },
];

function navigateFromDrawer(routeName: string) {
  switch (routeName) {
    case 'Home':
      rootNavigationRef.navigate('Home' as never);
      break;
    case 'Nutrition':
      rootNavigationRef.navigate('Nutrition' as never, { screen: 'Nutrition' } as never);
      break;
    case 'My Workouts':
      rootNavigationRef.navigate('My Workouts' as never, { screen: 'WorkoutsList' } as never);
      break;
    case 'My Progress':
      rootNavigationRef.navigate('My Progress' as never, { screen: 'MyProgress' } as never);
      break;
    case 'My Calendar':
      rootNavigationRef.navigate('My Calendar' as never, { screen: 'MyCalendar' } as never);
      break;
    default:
      rootNavigationRef.navigate(routeName as never);
  }
}

type AppDrawerProps = {
  visible: boolean;
  onClose: () => void;
};

export default function AppDrawer({ visible, onClose }: AppDrawerProps) {
  const insets = useSafeAreaInsets();
  const { profilePhotoUri, openProfileModal } = useProfile();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const slide = useRef(new Animated.Value(-DRAWER_WIDTH)).current;

  useEffect(() => {
    if (!visible) setAccountMenuOpen(false);
  }, [visible]);

  useEffect(() => {
    Animated.timing(slide, {
      toValue: visible ? 0 : -DRAWER_WIDTH,
      duration: visible ? 260 : 220,
      useNativeDriver: true,
    }).start();
  }, [visible, slide]);

  const goToProfile = () => {
    setAccountMenuOpen(false);
    onClose();
    requestAnimationFrame(() => openProfileModal());
  };

  const goToSettings = () => {
    setAccountMenuOpen(false);
    onClose();
    requestAnimationFrame(() => rootNavigationRef.navigate('Settings' as never));
  };

  const navigateTo = (routeName: string) => {
    onClose();
    navigateFromDrawer(routeName);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      presentationStyle={Platform.OS === 'ios' ? 'overFullScreen' : undefined}
      statusBarTranslucent={Platform.OS === 'android'}
      onRequestClose={onClose}
    >
      <View style={styles.modalRoot}>
        <Pressable
          style={[StyleSheet.absoluteFill, styles.backdropPress, styles.backdropZ]}
          onPress={onClose}
          accessibilityLabel="Close menu"
        />
        <Animated.View
          pointerEvents="box-none"
          style={[
            styles.drawer,
            styles.drawerZ,
            {
              width: DRAWER_WIDTH,
              top: insets.top,
              bottom: insets.bottom,
              paddingBottom: 14,
              transform: [{ translateX: slide }],
            },
          ]}
        >
          <View style={styles.drawerInner} pointerEvents="auto">
            <TouchableOpacity
              style={styles.brandingTouchable}
              onPress={() => navigateTo('Home')}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="MyVow Fit, go to Home"
            >
              <Text style={styles.brandingTitle}>MyVow Fit</Text>
            </TouchableOpacity>

            <ScrollView
              style={styles.navScroll}
              contentContainerStyle={styles.navScrollContent}
              showsVerticalScrollIndicator={false}
              bounces={false}
            >
              {NAV_ITEMS.map((item, index) => (
                <TouchableOpacity
                  key={item.routeName}
                  style={[
                    styles.navRow,
                    index < NAV_ITEMS.length - 1 ? styles.navRowWithDivider : null,
                  ]}
                  onPress={() => navigateTo(item.routeName)}
                  activeOpacity={0.75}
                  accessibilityRole="button"
                  accessibilityLabel={item.label}
                >
                  <Text style={styles.navLabel} numberOfLines={1}>
                    {item.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <View style={styles.avatarBlock}>
              {accountMenuOpen ? (
                <View style={styles.accountMenu} accessibilityRole="menu">
                  <TouchableOpacity
                    style={styles.accountMenuRow}
                    onPress={goToProfile}
                    activeOpacity={0.7}
                    accessibilityRole="menuitem"
                    accessibilityLabel="Profile"
                  >
                    <Ionicons name="person-outline" size={22} color={NAV_ITEM_BLACK} />
                    <Text style={styles.accountMenuRowText}>Profile</Text>
                  </TouchableOpacity>
                  <View style={styles.accountMenuDivider} />
                  <TouchableOpacity
                    style={styles.accountMenuRow}
                    onPress={goToSettings}
                    activeOpacity={0.7}
                    accessibilityRole="menuitem"
                    accessibilityLabel="Settings"
                  >
                    <Ionicons name="settings-outline" size={22} color={NAV_ITEM_BLACK} />
                    <Text style={styles.accountMenuRowText}>Settings</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
              <TouchableOpacity
                style={styles.drawerAvatarBtn}
                onPress={() => setAccountMenuOpen((o) => !o)}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel={accountMenuOpen ? 'Close account menu' : 'Open account menu'}
                accessibilityState={{ expanded: accountMenuOpen }}
              >
                {profilePhotoUri ? (
                  <Image source={{ uri: profilePhotoUri }} style={styles.drawerAvatarImage} />
                ) : (
                  <View style={styles.drawerAvatarIconWrap}>
                    <Ionicons name="person-circle-outline" size={36} color={AVATAR_SAGE} />
                  </View>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalRoot: {
    flex: 1,
  },
  backdropPress: {
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  backdropZ: {
    zIndex: 0,
  },
  drawerZ: {
    zIndex: 1,
    elevation: 16,
  },
  drawer: {
    position: 'absolute',
    left: 0,
    backgroundColor: DRAWER_SAGE_BG,
  },
  drawerInner: {
    flex: 1,
    minHeight: 0,
    backgroundColor: DRAWER_SAGE_BG,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: 'rgba(0,0,0,0.12)',
    shadowColor: '#000',
    shadowOffset: { width: 4, height: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 10,
    elevation: 8,
    paddingTop: 32,
    paddingHorizontal: 20,
  },
  brandingTouchable: {
    marginBottom: 14,
    alignSelf: 'flex-start',
    paddingBottom: 0,
  },
  /** Same size as nav rows; do not use navLabel here — its flex:1 collapses the nav ScrollView. */
  brandingTitle: {
    fontFamily: 'CormorantGaramond-Italic',
    fontSize: 28,
    lineHeight: 32,
    color: DRAWER_DARK_GREEN,
  },
  navScroll: {
    flex: 1,
  },
  navScrollContent: {
    paddingTop: 0,
    paddingBottom: 16,
    flexGrow: 1,
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
  },
  navRowWithDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#000000',
  },
  navLabel: {
    flex: 1,
    fontFamily: 'CormorantGaramond-Regular',
    fontSize: 28,
    color: NAV_ITEM_BLACK,
    lineHeight: 32,
  },
  avatarBlock: {
    alignSelf: 'stretch',
  },
  accountMenu: {
    marginBottom: 12,
    backgroundColor: BRANDING_CREAM,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#000000',
    borderRadius: 10,
    overflow: 'hidden',
  },
  accountMenuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 14,
    gap: 12,
  },
  accountMenuRowText: {
    flex: 1,
    fontFamily: 'CormorantGaramond-SemiBold',
    fontSize: 20,
    color: NAV_ITEM_BLACK,
  },
  accountMenuDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#000000',
  },
  drawerAvatarBtn: {
    alignSelf: 'flex-start',
    marginTop: 0,
    paddingVertical: 4,
  },
  drawerAvatarImage: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: AVATAR_SAGE,
  },
  drawerAvatarIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: AVATAR_SAGE,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
