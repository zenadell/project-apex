import 'package:dart_jsonwebtoken/dart_jsonwebtoken.dart';

String get validJwt {
  final jwt = JWT({'sub': 'test-user'});
  return jwt.sign(SecretKey('test_secret'));
}
