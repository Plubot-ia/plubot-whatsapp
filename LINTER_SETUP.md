# 🚀 Elite Linter Configuration - Setup Guide

## 📋 Instalación Rápida

```bash
# 1. Instalar todas las dependencias
npm install

# 2. Configurar Husky para pre-commit hooks
npm run prepare

# 3. Verificar que todo funciona
npm run quality:check
```

## 🎯 Scripts Disponibles

### Linting
```bash
# Verificar código
npm run lint

# Corregir automáticamente
npm run lint:fix

# Solo archivos staged (para pre-commit)
npm run lint:staged
```

### Formateo
```bash
# Formatear código
npm run format

# Verificar formato
npm run format:check
```

### Seguridad
```bash
# Auditoría de dependencias
npm run security:check

# Verificar archivo específico por seguridad
npm run security:check-file <archivo>
```

### Calidad Total
```bash
# Verificar todo (lint + format + security)
npm run quality:check

# Corregir todo lo posible
npm run quality:fix
```

### Testing
```bash
# Ejecutar tests con coverage
npm test

# Tests en modo watch
npm run test:watch

# Solo tests relacionados con archivos modificados
npm run test:staged
```

### Análisis
```bash
# Generar reporte de estadísticas ESLint
npm run analyze

# Generar reporte de complejidad
npm run complexity
```

## 🔧 Configuración

### ESLint Elite Features

La configuración incluye **10+ plugins** para máxima calidad:

| Plugin | Propósito |
|--------|-----------|
| `security` | Detecta vulnerabilidades de seguridad |
| `no-secrets` | Previene hardcoding de secretos |
| `sonarjs` | Detecta code smells y bugs |
| `unicorn` | 100+ reglas de mejores prácticas |
| `promise` | Manejo correcto de promesas |
| `import` | Orden y validación de imports |
| `jsdoc` | Documentación obligatoria |
| `optimize-regex` | Optimiza expresiones regulares |
| `node` | Mejores prácticas Node.js |

### Reglas Críticas Activadas

#### 🔒 Seguridad
- ✅ Detección de inyección de objetos
- ✅ Prevención de timing attacks
- ✅ Validación de regex seguros
- ✅ Sin eval() o Function()
- ✅ Sin secretos en código

#### 🎯 Calidad
- ✅ Complejidad ciclomática máx: 10
- ✅ Profundidad máx: 3 niveles
- ✅ Funciones máx: 50 líneas
- ✅ Archivos máx: 300 líneas
- ✅ Sin strings duplicados (>3)

#### 🚀 Performance
- ✅ Optimización de regex
- ✅ Prefer-at sobre array[index]
- ✅ Sin forEach innecesarios
- ✅ Uso de métodos nativos modernos

## 🔄 Pre-commit Hooks

Los hooks automáticamente:
1. Ejecutan ESLint en archivos staged
2. Formatean con Prettier
3. Verifican seguridad
4. Ejecutan tests relacionados

Para saltear temporalmente (NO recomendado):
```bash
git commit --no-verify -m "mensaje"
```

## 📊 CI/CD Pipeline

El workflow de GitHub Actions incluye:

1. **Quality Check**: ESLint + Prettier + Security
2. **Test Suite**: Jest con coverage + Redis
3. **Complexity Analysis**: Métricas de código
4. **Docker Build**: Construcción de imagen
5. **Dependency Check**: Snyk vulnerabilities

## 🐛 Solución de Problemas

### Error: "ESLint couldn't find plugin"
```bash
npm ci
```

### Error: "Husky - command not found"
```bash
npx husky install
```

### Error: "Too many ESLint errors"
```bash
# Corregir automáticamente lo posible
npm run lint:fix

# Ver solo errores (sin warnings)
npx eslint . --quiet
```

### Desactivar regla temporalmente
```javascript
// eslint-disable-next-line rule-name
const problematicCode = 'temporal';

/* eslint-disable rule-name */
// Bloque de código
/* eslint-enable rule-name */
```

## 📈 Métricas de Calidad

Ejecutar análisis completo:
```bash
# Generar todos los reportes
npm run analyze && npm run complexity

# Ver estadísticas
cat eslint-stats.json | jq '.rules | to_entries | sort_by(.value) | reverse | .[0:10]'
```

## 🎓 Mejores Prácticas

### 1. Documentación JSDoc
```javascript
/**
 * Procesa mensajes de WhatsApp.
 * @param {string} sessionId - ID único de sesión
 * @param {Object} message - Mensaje a procesar
 * @returns {Promise<void>} Promesa vacía al completar
 * @throws {Error} Si la sesión no existe
 */
async function processMessage(sessionId, message) {
  // ...
}
```

### 2. Manejo de Errores
```javascript
try {
  await riskyOperation();
} catch (error) {
  logger.error('Operation failed', {
    error: error.message,
    stack: error.stack,
    context: { sessionId }
  });
  throw new CustomError('Operation failed', { cause: error });
}
```

### 3. Validación con Zod
```javascript
import { z } from 'zod';

const MessageSchema = z.object({
  to: z.string().regex(/^\d{10,15}$/),
  message: z.string().max(4096),
  sessionId: z.string().uuid()
});

function validateMessage(data) {
  return MessageSchema.parse(data);
}
```

## 🚨 Reglas No Negociables

Estas reglas SIEMPRE deben cumplirse:

1. **NO console.log** en producción
2. **NO var**, solo const/let
3. **NO callbacks**, usar async/await
4. **NO magic numbers**, usar constantes
5. **NO any** en TypeScript
6. **NO commits sin tests**
7. **NO merge sin review**
8. **NO secretos hardcodeados**

## 📚 Recursos

- [ESLint Rules](https://eslint.org/docs/rules/)
- [Unicorn Plugin](https://github.com/sindresorhus/eslint-plugin-unicorn)
- [Security Plugin](https://github.com/nodesecurity/eslint-plugin-security)
- [SonarJS](https://github.com/SonarSource/eslint-plugin-sonarjs)

---

**Configuración creada por:** Cascade AI Assistant  
**Nivel:** Elite/Enterprise  
**Compatibilidad:** Node.js 20+
