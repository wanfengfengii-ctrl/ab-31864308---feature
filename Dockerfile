# syntax=docker/dockerfile:1
# 无源光纤监测网拓扑重建工作台 —— 纯静态站点镜像（nginx）
FROM nginx:1.27-alpine

# 用自定义 server 配置（含 /healthz 健康检查端点）
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 拷贝静态应用（应用本身不含任何后端依赖）
COPY index.html /usr/share/nginx/html/index.html
COPY css/ /usr/share/nginx/html/css/
COPY js/ /usr/share/nginx/html/js/

EXPOSE 80

# 容器级健康检查
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1/healthz | grep -q ok || exit 1
