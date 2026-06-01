import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SafeAreaView, View, Text, TextInput, Pressable, FlatList, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const API_URL = 'http://localhost:8080';

async function request(path, token, options = {}) {
  const response = await fetch(`${API_URL}/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export default function App() {
  const [token, setToken] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [user, setUser] = useState(null);
  const [chats, setChats] = useState([]);
  const [activeChat, setActiveChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [body, setBody] = useState('');
  const ws = useRef(null);
  const wsUrl = useMemo(() => API_URL.replace(/^http/, 'ws'), []);

  useEffect(() => { AsyncStorage.getItem('token').then(saved => saved && setToken(saved)); }, []);
  useEffect(() => { if (token) bootstrap(); }, [token]);

  async function bootstrap() {
    const me = await request('/me', token);
    setUser(me.user);
    const result = await request('/chats', token);
    setChats(result.chats);
    connectSocket();
  }

  function connectSocket() {
    ws.current?.close();
    ws.current = new WebSocket(`${wsUrl}/ws?token=${token}`);
    ws.current.onmessage = event => {
      const payload = JSON.parse(event.data);
      if (payload.event === 'message:new' && payload.data.chat_id === activeChat?.id) setMessages(items => [...items, payload.data]);
    };
  }

  async function signIn() {
    const result = await request('/auth/login', '', { method: 'POST', body: { login, password } });
    await AsyncStorage.setItem('token', result.accessToken);
    setToken(result.accessToken);
    setUser(result.user);
  }

  async function openChat(chat) {
    setActiveChat(chat);
    const result = await request(`/chats/${chat.id}/messages`, token);
    setMessages(result.messages);
    await request(`/chats/${chat.id}/read`, token, { method: 'POST' }).catch(() => {});
  }

  async function sendMessage() {
    if (!body.trim() || !activeChat) return;
    const result = await request(`/chats/${activeChat.id}/messages`, token, { method: 'POST', body: { body } });
    setMessages(items => [...items, result.message]);
    setBody('');
  }

  if (!token || !user) return <SafeAreaView style={styles.screen}><View style={styles.card}><Text style={styles.title}>Liquid Messenger</Text><TextInput style={styles.input} placeholder="Email или username" placeholderTextColor="#9ca3af" value={login} onChangeText={setLogin}/><TextInput style={styles.input} placeholder="Пароль" placeholderTextColor="#9ca3af" secureTextEntry value={password} onChangeText={setPassword}/><Pressable style={styles.button} onPress={signIn}><Text style={styles.buttonText}>Войти</Text></Pressable></View></SafeAreaView>;

  return <SafeAreaView style={styles.screen}><View style={styles.layout}><FlatList style={styles.list} data={chats} keyExtractor={item => item.id} renderItem={({ item }) => <Pressable style={styles.item} onPress={() => openChat(item)}><Text style={styles.name}>{item.title || item.type}</Text><Text style={styles.muted}>{item.last_message || 'Нет сообщений'}</Text></Pressable>}/><View style={styles.chat}><Text style={styles.title}>{activeChat?.title || 'Выберите чат'}</Text><FlatList data={messages} keyExtractor={item => item.id} renderItem={({ item }) => <View style={[styles.message, item.sender_id === user.id && styles.mine]}><Text style={styles.messageText}>{item.body}</Text></View>}/><View style={styles.composer}><TextInput style={styles.input} value={body} onChangeText={setBody} placeholder="Сообщение" placeholderTextColor="#9ca3af"/><Pressable style={styles.button} onPress={sendMessage}><Text style={styles.buttonText}>Send</Text></Pressable></View></View></View></SafeAreaView>;
}

const styles = StyleSheet.create({ screen:{ flex:1, backgroundColor:'#111827', padding:12 }, card:{ margin:'auto', padding:24, borderRadius:28, backgroundColor:'rgba(255,255,255,.12)' }, title:{ color:'white', fontSize:20, fontWeight:'700', marginBottom:12 }, input:{ color:'white', backgroundColor:'rgba(255,255,255,.08)', borderRadius:16, padding:12, marginVertical:6 }, button:{ backgroundColor:'#0a84ff', borderRadius:16, padding:12, alignItems:'center' }, buttonText:{ color:'white', fontWeight:'700' }, layout:{ flex:1, flexDirection:'row', gap:10 }, list:{ flex:.42 }, chat:{ flex:.58 }, item:{ padding:12, borderRadius:16, backgroundColor:'rgba(255,255,255,.08)', marginBottom:8 }, name:{ color:'white', fontWeight:'700' }, muted:{ color:'#9ca3af' }, message:{ padding:10, borderRadius:16, backgroundColor:'rgba(255,255,255,.10)', marginVertical:4 }, mine:{ backgroundColor:'#0a84ff' }, messageText:{ color:'white' }, composer:{ flexDirection:'row', gap:8, alignItems:'center' } });
