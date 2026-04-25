// Servidores STUN activos. WebRTC los prueba todos en paralelo:
// el primero que responda gana. Con pocos servidores confiables
// el ICE gathering termina rápido y no se generan candidatos de más.
window.iceServers = [
  {
    urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun2.l.google.com:19302",
      "stun:stun3.l.google.com:19302",
      "stun:stun4.l.google.com:19302",
    ],
  },
];
