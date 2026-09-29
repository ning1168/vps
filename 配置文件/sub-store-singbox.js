{
  "log": {
    "level": "info",
    "timestamp": true
  },
  "dns": {
    "servers": [
      {
        "tag": "本地DNS",
        "type": "local"
      },
      {
        "tag": "Cloudflare-DoH",
        "type": "https",
        "server": "1.1.1.1",
        "server_port": 443,
        "path": "/dns-query",
        "tls": {
          "enabled": true,
          "server_name": "cloudflare-dns.com"
        },
        "detour": "手动选择"
      }
    ],
    "rules": [
      { "clash_mode": "Direct", "action": "route", "server": "本地DNS" },
      { "clash_mode": "Global", "action": "route", "server": "Cloudflare-DoH" },
      { "rule_set": "广告拦截", "action": "reject" },
      { "domain_suffix": ["qq.com"], "action": "route", "server": "本地DNS" },
      {
        "rule_set": ["geosite-cn", "geosite-geolocation-cn"],
        "action": "route",
        "server": "本地DNS"
      }
    ],
    "final": "Cloudflare-DoH",
    "strategy": "ipv4_only"
  },
  "inbounds": [
    {
      "type": "tun",
      "tag": "tun-in",
      "address": ["172.19.0.1/30"],
      "mtu": 9000,
      "auto_route": true,
      "strict_route": true,
      "stack": "mixed"
    }
  ],
  "outbounds": [
    {
      "type": "selector",
      "tag": "手动选择",
      "outbounds": ["自动选择"],
      "default": "自动选择"
    },
    {
      "type": "urltest",
      "tag": "自动选择",
      "outbounds": ["direct"],
      "url": "https://www.gstatic.com/generate_204",
      "interval": "3m",
      "tolerance": 50
    },
    {
      "type": "selector",
      "tag": "苹果服务",
      "outbounds": ["direct", "手动选择", "自动选择"],
      "default": "direct"
    },
    {
      "type": "selector",
      "tag": "微软服务",
      "outbounds": ["direct", "手动选择", "自动选择"],
      "default": "direct"
    },
    {
      "type": "selector",
      "tag": "谷歌服务",
      "outbounds": ["手动选择", "自动选择", "direct"],
      "default": "手动选择"
    },
    { "type": "direct", "tag": "direct" }
  ],
  "route": {
    "default_domain_resolver": { "server": "本地DNS", "strategy": "ipv4_only" },
    "auto_detect_interface": true,
    "final": "手动选择",
    "rules": [
      { "action": "sniff" },
      { "protocol": "dns", "action": "hijack-dns" },
      { "port": 53, "action": "hijack-dns" },
      { "ip_is_private": true, "action": "route", "outbound": "direct" },
      { "clash_mode": "Direct", "action": "route", "outbound": "direct" },
      { "clash_mode": "Global", "action": "route", "outbound": "手动选择" },
      {
        "type": "logical",
        "mode": "or",
        "rules": [
          { "protocol": "quic" },
          { "network": "udp", "port": 443 },
          { "port": 853 }
        ],
        "action": "reject"
      },
      { "rule_set": "广告拦截", "action": "reject" },
      { "domain_suffix": ["qq.com"], "action": "route", "outbound": "direct" },
      { "ip_cidr": ["192.0.2.100/32"], "action": "route", "outbound": "手动选择" },
      { "rule_set": "geosite-apple", "action": "route", "outbound": "苹果服务" },
      { "rule_set": "geosite-microsoft", "action": "route", "outbound": "微软服务" },
      { "rule_set": "geosite-google", "action": "route", "outbound": "谷歌服务" },
      { "rule_set": ["geosite-cn", "geoip-cn"], "action": "route", "outbound": "direct" },
      { "rule_set": "geosite-geolocation-!cn", "action": "route", "outbound": "手动选择" }
    ],
    "rule_set": [
      { "type": "remote", "tag": "广告拦截", "format": "binary", "url": "https://gcore.jsdelivr.net/gh/217heidai/adblockfilters@main/rules/adblocksingbox.srs", "update_interval": "3d" },
      { "type": "remote", "tag": "geosite-cn", "format": "binary", "url": "https://gcore.jsdelivr.net/gh/SagerNet/sing-geosite@rule-set/geosite-cn.srs", "update_interval": "3d" },
      { "type": "remote", "tag": "geosite-geolocation-cn", "format": "binary", "url": "https://gcore.jsdelivr.net/gh/SagerNet/sing-geosite@rule-set/geosite-geolocation-cn.srs", "update_interval": "3d" },
      { "type": "remote", "tag": "geosite-geolocation-!cn", "format": "binary", "url": "https://gcore.jsdelivr.net/gh/SagerNet/sing-geosite@rule-set/geosite-geolocation-!cn.srs", "update_interval": "3d" },
      { "type": "remote", "tag": "geosite-apple", "format": "binary", "url": "https://gcore.jsdelivr.net/gh/SagerNet/sing-geosite@rule-set/geosite-apple.srs", "update_interval": "3d" },
      { "type": "remote", "tag": "geosite-microsoft", "format": "binary", "url": "https://gcore.jsdelivr.net/gh/SagerNet/sing-geosite@rule-set/geosite-microsoft.srs", "update_interval": "3d" },
      { "type": "remote", "tag": "geosite-google", "format": "binary", "url": "https://gcore.jsdelivr.net/gh/SagerNet/sing-geosite@rule-set/geosite-google.srs", "update_interval": "3d" },
      { "type": "remote", "tag": "geoip-cn", "format": "binary", "url": "https://gcore.jsdelivr.net/gh/SagerNet/sing-geoip@rule-set/geoip-cn.srs", "update_interval": "3d" }
    ]
  },
  "experimental": {
    "clash_api": {
      "external_controller": "127.0.0.1:9090",
      "default_mode": "rule"
    },
    "cache_file": {
      "enabled": true,
      "store_fakeip": false
    }
  }
}
