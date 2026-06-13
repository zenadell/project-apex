import 'package:shelf/shelf.dart';
import 'package:dart_jsonwebtoken/dart_jsonwebtoken.dart';
import '../config/config.dart';

Middleware authMiddleware() {
  return (Handler innerHandler) {
    return (Request request) async {
      final authHeader = request.headers['authorization'];
      if (authHeader == null || !authHeader.startsWith('Bearer ')) {
        return Response.unauthorized('Missing or invalid Authorization header');
      }
      final token = authHeader.substring(7);
      try {
        final jwt = JWT.verify(token, SecretKey(Config().jwtSecret));
        // Attach decoded payload to request context
        final newRequest = request.change(context: {
          ...request.context,
          'user': jwt.payload,
        });
        return await innerHandler(newRequest);
      } catch (e) {
        return Response.unauthorized('Invalid token');
      }
    };
  };
}
