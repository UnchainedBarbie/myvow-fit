/**
 * Circular avatar for headerRight. Sage border, 32x32. Shows profile photo or person icon.
 * Tap → Alert: Edit Profile, Settings, Cancel.
 */
import React from 'react';
import { View, TouchableOpacity, Image, Alert, StyleSheet } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import { useProfile } from '../context/ProfileContext';

const SAGE = '#7C9A7E';

export function openProfileAccountAlert(opts: {
  openProfileModal: () => void;
  navigateToSettings: () => void;
}) {
  Alert.alert('Profile', undefined, [
    { text: 'Edit Profile', onPress: opts.openProfileModal },
    { text: 'Settings', onPress: opts.navigateToSettings },
    { text: 'Cancel', style: 'cancel' },
  ]);
}

export default function HeaderAvatar() {
  const navigation = useNavigation<any>();
  const { profilePhotoUri, openProfileModal } = useProfile();

  const onPress = () => {
    openProfileAccountAlert({
      openProfileModal,
      navigateToSettings: () => navigation.navigate('Settings'),
    });
  };

  return (
    <TouchableOpacity onPress={onPress} style={styles.wrap} activeOpacity={0.7}>
      {profilePhotoUri ? (
        <Image source={{ uri: profilePhotoUri }} style={styles.avatar} />
      ) : (
        <View style={styles.iconWrap}>
          <Ionicons name="person-circle-outline" size={32} color={SAGE} />
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: 32,
    height: 32,
    marginRight: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: SAGE,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: SAGE,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
